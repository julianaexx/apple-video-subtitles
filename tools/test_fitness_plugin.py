import json
import re
import unittest

from build_fitness_plugin import rules_for
from subtitle_hls import vtt


class FitnessPluginTests(unittest.TestCase):
    def test_remote_assets_and_exact_course_matching(self):
        ids = {"id": "123456789", "a": "987654321"}
        donor = "https://hls-svod.itunes.apple.com/subs/P123456789_A987654321_en_subtitles_V2.m3u8"
        text = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n1\n00:00:00.000 --> 00:00:02.000\n下蹲，再站直。\n\n"
        files = {"index.m3u8": "#EXTM3U\n#EXTINF:2,\nseg-000000.vtt\n#EXT-X-ENDLIST\n", "seg-000000.vtt": text}
        remote = "https://raw.githubusercontent.com/example/subtitles/main/fitness/course/"
        rules, pattern, match_donor, track = rules_for(ids, donor, remote)
        master = "https://play.itunes.apple.com/WebObjects/MZPlay.woa/hls/fitness/playlist.m3u8"
        self.assertTrue(re.fullmatch(pattern, master + "?cc=us&a=987654321&id=123456789&token=ignored"))
        self.assertFalse(re.fullmatch(pattern, master + "?a=987654320&id=123456789"))
        self.assertFalse(re.fullmatch(pattern, master + "?a=987654321&id=123456780"))
        row = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",LANGUAGE="en",URI="' + donor + '"'
        self.assertEqual(re.findall(match_donor, row), [row])
        self.assertEqual(re.findall(match_donor, row.replace('LANGUAGE="en"', 'LANGUAGE="de"')), [])
        self.assertIn('GROUP-ID="subtitles"', track)
        self.assertIn('LANGUAGE="zh-Hans"', track)
        self.assertEqual(len(rules), 2)
        self.assertIn(remote + "index.m3u8", track)
        self.assertNotIn("response.body.mock", "\n".join(rules))
        self.assertNotIn("下蹲", "\n".join(rules))
        self.assertEqual(len(vtt(text)[1]), 1)


if __name__ == "__main__":
    unittest.main()
