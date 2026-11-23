"""Regression checks for independent subtitle assets and live rollover."""

import json
from pathlib import Path
import re
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen

from live_subtitles import LiveTrack, SCRIPT_PATH, handler_for
from local_catalog import compile_catalog
from prepare_subtitles import extract, prepare

VTT = "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n1\n00:00:00.000 --> 00:00:02.000 line:90%\nBrake now\n\n"
MASTER = ('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cc",LANGUAGE="en",NAME="English",URI="en/index.m3u8"\n'
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="cc"\nvideo.m3u8\n')


def media(sequence, *segments, ended=False):
    return (f"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n"
            + "".join(f"#EXTINF:4.0,\n{uri}\n" for uri in segments)
            + ("#EXT-X-ENDLIST\n" if ended else ""))


class ExtensionTests(unittest.TestCase):
    def test_vod_prep_and_http_serving(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "en.m3u8"
            source.write_text(media(7, "en.vtt", ended=True), encoding="utf-8")
            (root / "en.vtt").write_text(VTT, encoding="utf-8")
            worksheet = extract(source)
            with self.assertRaisesRegex(ValueError, "missing translation"):
                prepare(source, worksheet)
            next(iter(worksheet["cues"].values()))["translation"] = "现在刹车"
            folder = root / "f1-sample"
            folder.mkdir()
            for name, text in prepare(source, worksheet).items():
                (folder / name).write_bytes(text.encode("utf-8"))
            with ThreadingHTTPServer(("127.0.0.1", 0), handler_for(root, {})) as server:
                worker = threading.Thread(target=server.serve_forever)
                worker.start()
                try:
                    base = f"http://127.0.0.1:{server.server_port}"
                    with urlopen(base + "/vod/f1-sample/index.m3u8") as response:
                        self.assertEqual(response.headers["Content-Type"], "application/vnd.apple.mpegurl")
                        self.assertIn(b"#EXT-X-ENDLIST", response.read())
                    with urlopen(base + "/vod/f1-sample/seg-000000.vtt") as response:
                        self.assertEqual(response.read().decode(), VTT.replace("Brake now", "现在刹车"))
                    with urlopen(base + SCRIPT_PATH) as response:
                        self.assertEqual(response.status, 200)
                    with self.assertRaises(HTTPError):
                        urlopen(base + "/vod/f1-sample/../../en.vtt")
                finally:
                    server.shutdown()
                    worker.join()

    def test_live_window_reuses_segment_and_recovers(self):
        url = "https://captions.example.test/live.m3u8"
        source = {"playlist": media(44, "044.vtt", "045.vtt?sig=a")}
        translated = []
        failed = False

        def fetch(request):
            if request == url:
                return source["playlist"], request
            if failed and "/046.vtt" in request:
                raise OSError("sample interruption")
            return VTT, request

        def translate(cues):
            translated.extend(cues)
            return ["现在刹车"] * len(cues)

        track = LiveTrack(url, fetch, translate)
        self.assertIsNone(track.get("index.m3u8"))
        track.poll()
        first = track.get("index.m3u8")
        source["playlist"] = media(45, "045.vtt?sig=b", "046.vtt").replace("#EXTINF:4.0,\n046", "#EXT-X-DISCONTINUITY\n#EXTINF:4.0,\n046")
        failed = True
        with self.assertRaises(OSError):
            track.poll()
        self.assertEqual(track.get("index.m3u8"), first)
        failed = False
        track.poll()
        second = track.get("index.m3u8")
        self.assertEqual(len(translated), 3)
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:45", second)
        self.assertIn("#EXT-X-DISCONTINUITY", second)
        self.assertNotIn("#EXT-X-ENDLIST", second)
        self.assertNotIn("sig=", second)
        old_segment = next(line for line in first.splitlines() if line.startswith("seg-44-"))
        self.assertIn("现在刹车", track.get(old_segment))

    def test_catalog_scopes_shared_master_to_one_program(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "master.m3u8").write_text(MASTER, encoding="utf-8")
            values = {
                "version": 1, "script_base_url": "https://captions.example.test",
                "programs": [{"id": "sample", "kind": "fitness", "master_sample": "master.m3u8",
                              "master_url": "https://test.example.test/master.m3u8", "master_query": {"id": "one"},
                              "subtitle_url": "https://captions.example.test/vod/sample/index.m3u8"}],
            }
            path = root / "catalog.json"
            path.write_text(json.dumps(values), encoding="utf-8")
            rules, hosts, resources = compile_catalog(path)
            regex = rules[0].split()[1]
            self.assertTrue(re.fullmatch(regex, "https://test.example.test/master.m3u8?sig=rotating&id=one"))
            self.assertFalse(re.fullmatch(regex, "https://test.example.test/master.m3u8?id=another"))
            self.assertFalse(re.fullmatch(regex, "https://test.example.test/master.m3u8?other=a?id=one"))
            self.assertEqual(hosts, ["test.example.test"])
            self.assertEqual(list(resources), ["https://captions.example.test" + SCRIPT_PATH])
            values["programs"].append({**values["programs"][0], "id": "different"})
            path.write_text(json.dumps(values), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "overlap"):
                compile_catalog(path)


if __name__ == "__main__":
    unittest.main()
