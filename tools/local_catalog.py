"""Compile exact HLS-master rewrites for user-owned VOD/live subtitle tracks."""

import json
import hashlib
from pathlib import Path
import re
from urllib.parse import quote, urlsplit

ATTR = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


def exact_url(value):
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.port not in (443, None) or url.query or url.fragment
            or re.search(r"[\s'\"\\,]", value)):
        raise ValueError("master_url must be an HTTPS URL without query, credentials, or fragments")
    return url


def compile_catalog(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if set(data) - {"version", "programs", "script_base_url"} or data.get("version") != 1 or not isinstance(data.get("programs"), list):
        raise ValueError("expected version 1 and programs list in local catalog")
    if not data["programs"]:
        return [], [], {}
    base = data.get("script_base_url", "").rstrip("/")
    exact_url(base)
    script = Path(__file__).with_name("inject_subtitles.js").read_bytes().replace(b"\r\n", b"\n")
    script_url = base + "/loon/inject-" + hashlib.sha256(script).hexdigest()[:16] + ".js"
    rules, hosts, seen, ids = [], [], set(), set()
    for row in data["programs"]:
        required = {"id", "kind", "master_url", "master_sample", "subtitle_url"}
        if not required <= set(row) or set(row) - required - {"master_query"}:
            raise ValueError("program needs id, kind, master_url, master_sample, subtitle_url")
        if (not re.fullmatch(r"[a-z0-9-]+", row["id"]) or row["id"] in ids
                or row["kind"] not in {"f1-replay", "fitness", "f1-live"}):
            raise ValueError("invalid or duplicate program id/kind")
        ids.add(row["id"])
        origin = exact_url(row["master_url"])
        exact_url(row["subtitle_url"])
        selector = row.get("master_query", {})
        if not isinstance(selector, dict) or any(not re.fullmatch(r"[\w.-]+", key, re.ASCII)
                                                 or not isinstance(value, str)
                                                 or not re.fullmatch(r"[\w.%-]+", value, re.ASCII)
                                                 for key, value in selector.items()):
            raise ValueError("master_query must contain only stable URL-safe program identifier fields")
        for url, entries in seen:
            if url == row["master_url"] and not any(key in selector and selector[key] != value for key, value in entries):
                raise ValueError("master URL selectors overlap")
        seen.add((row["master_url"], tuple(sorted(selector.items()))))
        sample = (Path(path).parent / row["master_sample"]).resolve()
        # Keep imported samples inside the catalog folder.
        if not sample.is_relative_to(Path(path).parent.resolve()):
            raise ValueError("master sample must stay inside catalog folder")
        lines = sample.read_text(encoding="utf-8-sig").splitlines()
        if not lines or lines[0] != "#EXTM3U":
            raise ValueError("invalid master sample")
        variants = []
        tracks = []
        for line in lines:
            if line.startswith("#EXT-X-STREAM-INF:"):
                variants.append({k: v.strip('"') for k, v in ATTR.findall(line)})
            elif line.startswith("#EXT-X-MEDIA:"):
                tracks.append({k: v.strip('"') for k, v in ATTR.findall(line)})
        if not variants or any(not variant.get("SUBTITLES") for variant in variants):
            raise ValueError("every video variant must already declare a subtitle group; collect a supported sample first")
        for variant in variants:
            group = variant["SUBTITLES"]
            if not any(track.get("TYPE") == "SUBTITLES" and track.get("GROUP-ID") == group and track.get("URI")
                       and re.fullmatch(r"en(?:-[A-Za-z0-9-]+)?", track.get("LANGUAGE", ""), re.I)
                       and track.get("FORCED") != "YES" and track.get("PATHWAY-ID") in (None, variant.get("PATHWAY-ID"))
                       for track in tracks):
                raise ValueError(f"missing independent English subtitle track in group {group}")
        guard = "".join(fr"(?=\?(?:[^#&]*&)*{re.escape(key)}={re.escape(value)}(?:&|$))"
                        for key, value in sorted(selector.items()))
        # Only inspect query fields after the exact path. Ignore rotating signatures.
        pattern = "^" + re.escape(row["master_url"]) + guard + r"(?:\?[^#]*)?$"
        argument = quote(json.dumps({"id": row["id"], "url": row["subtitle_url"]}, separators=(",", ":")), safe="")
        rules.append(f'http-response {pattern} script-path={script_url},requires-body=true,max-size=0,'
                     f'argument="{argument}",timeout=10,tag=Local.{row["kind"]}.{row["id"]},enable=true')
        hosts.append(origin.hostname)
    return rules, hosts, {script_url: script}
