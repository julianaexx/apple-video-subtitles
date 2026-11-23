"""Serve prepared VOD tracks and translate rolling HLS WebVTT subtitles."""

import argparse
from dataclasses import dataclass
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from pathlib import Path
import re
import subprocess
import threading
import time
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from subtitle_hls import playlist, translate_vtt

LOG = logging.getLogger(__name__)
MAX_DOCUMENT = 2 * 1024 * 1024
JAVA_SCRIPT = Path(__file__).with_name("inject_subtitles.js").read_bytes().replace(b"\r\n", b"\n")
SCRIPT_PATH = "/loon/inject-" + hashlib.sha256(JAVA_SCRIPT).hexdigest()[:16] + ".js"


class Source:
    def __init__(self, source_url, hosts):
        self.hosts = {urlsplit(source_url).hostname, *hosts}
        self.check(source_url)

        class Redirects(HTTPRedirectHandler):
            def redirect_request(_, req, fp, code, msg, headers, newurl):
                self.check(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)

        self.opener = build_opener(Redirects())

    def check(self, url):
        parts = urlsplit(url)
        local = parts.hostname in {"localhost", "127.0.0.1", "::1"}
        if ((parts.scheme != "https" and not (local and parts.scheme == "http"))
                or not parts.hostname or parts.hostname not in self.hosts or parts.username or parts.password):
            raise ValueError("source URL is outside the configured subtitle hosts")

    def get(self, url):
        self.check(url)
        with self.opener.open(Request(url, headers={"Accept-Encoding": "identity"}), timeout=5) as response:
            data = response.read(MAX_DOCUMENT + 1)
            if len(data) > MAX_DOCUMENT:
                raise ValueError("upstream subtitle document is too large")
            return data.decode("utf-8-sig"), response.geturl()


@dataclass(frozen=True)
class Segment:
    name: str
    body: str


class LiveTrack:
    def __init__(self, source_url, fetch, translate):
        self.source_url, self.fetch, self.translate = source_url, fetch, translate
        self.lock = threading.Lock()
        self.cache = {}
        self.names = {}
        self.master = None
        self.valid_until = 0
        self.sequence = -1
        self.failed = 0
        self.last_advance = 0
        self.end = False

    def poll(self):
        text, base_url = self.fetch(self.source_url)
        media = playlist(text)
        end_sequence = media.sequence + len(media.segments) - 1
        if end_sequence < self.sequence:
            raise ValueError("upstream sequence went backwards")
        if len(media.segments) > 100:
            raise ValueError("live subtitle window exceeds 100 segments")
        self.cache = {key: segment for key, segment in self.cache.items() if key[0] >= media.sequence}
        next_cache = {}
        for index, (_, uri) in enumerate(media.segments, media.sequence):
            segment_url = urljoin(base_url, uri)
            # Signed query strings can change on every refresh. Sequence and path
            # identify the same rendition segment within this configured event.
            parsed = urlsplit(segment_url)
            key = (index, parsed.netloc, parsed.path)
            segment = self.cache.get(key)
            if segment is None:
                original, _ = self.fetch(segment_url)
                body = translate_vtt(original, self.translate)
                name_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
                segment = Segment(f"seg-{index}-{name_hash}.vtt", body)
                # Successful work survives a later segment failure in this poll.
                self.cache[key] = segment
            next_cache[key] = segment
        now = time.monotonic()
        batch = tuple(next_cache.values())
        content = media.render([segment.name for segment in batch])
        with self.lock:
            # Keep the previous window available for players already downloading it.
            self.names = {k: value for k, value in self.names.items() if value[1] > now}
            self.names.update({segment.name: (segment.body, now + max(60, media.target_duration * 6)) for segment in batch})
            self.master = content
            if end_sequence > self.sequence or not self.last_advance:
                self.last_advance = now
            self.valid_until = self.last_advance + max(30, media.target_duration * 6)
            self.sequence, self.end = end_sequence, media.ended
        self.cache = next_cache
        return max(1, min(media.target_duration / 2, 10))

    def run(self, stop):
        while not stop.is_set():
            try:
                delay = self.poll()
                if self.end:
                    return
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                self.failed += 1
                LOG.warning("Subtitle refresh failed (%s). Retry in 3 seconds", type(error).__name__)
                delay = 3
            stop.wait(delay)

    def get(self, name):
        with self.lock:
            now = time.monotonic()
            if name == "index.m3u8":
                if self.master and (now < self.valid_until or self.end):
                    return self.master
                return None
            found = self.names.get(name)
            if found and (found[1] > now or self.end):
                return found[0]
        return None


def translator(command, timeout):
    def translate(texts):
        result = subprocess.run(command, input=json.dumps(texts, ensure_ascii=False).encode("utf-8"),
                                capture_output=True, timeout=timeout, check=True, shell=False)
        return json.loads(result.stdout.decode("utf-8"))
    return translate


def handler_for(vod_root, tracks):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            if path == SCRIPT_PATH:
                self.send_data(JAVA_SCRIPT, "application/javascript", "public, max-age=31536000, immutable")
                return
            match = re.fullmatch(r"/(live|vod)/([a-z0-9-]+)/(index\.m3u8|seg-[0-9a-f-]+\.vtt)", path)
            if not match:
                self.send_error(404)
                return
            kind, key, name = match.groups()
            if kind == "live" and key in tracks:
                text = tracks[key].get(name)
                if text is None:
                    self.send_error(503 if name == "index.m3u8" else 404)
                    return
                data = text.encode("utf-8")
            elif kind == "vod" and vod_root:
                file = (vod_root / key / name).resolve()
                if not file.is_relative_to(vod_root) or not file.is_file():
                    self.send_error(404)
                    return
                data = file.read_bytes()
            else:
                self.send_error(404)
                return
            is_playlist = name.endswith(".m3u8")
            content_type = "application/vnd.apple.mpegurl" if is_playlist else "text/vtt; charset=utf-8"
            self.send_data(data, content_type, "no-store" if is_playlist else "public, max-age=60")

        def send_data(self, data, content_type, cache_control):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache_control)
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if config.get("version") != 1 or not isinstance(config.get("live"), dict):
            raise ValueError("expected version 1 and live channel mapping")
        vod_root = (args.config.parent / config["vod_root"]).resolve() if config.get("vod_root") else None
        if vod_root and not vod_root.is_dir():
            raise ValueError("vod_root does not exist")
        tracks = {}
        for key, track in config["live"].items():
            command = track["translate_command"]
            if not re.fullmatch(r"[a-z0-9-]+", key) or not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
                raise ValueError("invalid channel id or translator command")
            timeout = float(track.get("translate_timeout", 5))
            if not 0 < timeout <= 30:
                raise ValueError("translate_timeout must be within 0–30 seconds")
            fetcher = Source(track["source_url"], track.get("segment_hosts", []))
            tracks[key] = LiveTrack(track["source_url"], fetcher.get, translator(command, timeout))
        server = ThreadingHTTPServer((args.bind, args.port), handler_for(vod_root, tracks))
    except (KeyError, OSError, ValueError) as error:
        parser.exit(1, f"Subtitle service configuration failed: {error}\n")
    stop = threading.Event()
    for track in tracks.values():
        threading.Thread(target=track.run, args=(stop,), daemon=True).start()
    LOG.info("Subtitle service listening on %s:%s", *server.server_address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
