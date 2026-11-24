"""Regression checks for the Music-safe single-plugin release."""
import hashlib
import re
import unittest

from build_release import release_files
from generate_loon import ROOT


class UnifiedReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = release_files(ROOT / 'config/release.json')
        cls.plugin = cls.files['loon/apple-video-subtitles.plugin']

    def test_shared_playback_hosts_are_not_decrypted(self):
        hosts = next(line for line in self.plugin.splitlines() if line.startswith('hostname = '))
        hosts = hosts.partition(' = ')[2].split(', ')
        for host in ('play.itunes.apple.com', 'play-edge.itunes.apple.com', 'linear.tv.apple.com'):
            self.assertNotIn(host, hosts)
        self.assertNotIn('skip-server-cert-verify', self.plugin)
        self.assertNotIn('Fitness.DeepSeek.Master', self.plugin)
        self.assertNotIn('Fitness+ course', self.plugin)

    def test_single_uts_handler_and_native_fitness_matching(self):
        self.assertNotIn('response-body-json-jq', self.plugin)
        handlers = [line for line in self.plugin.splitlines()
                    if line.startswith('http-response') and 'uts-api' in line]
        self.assertEqual(len(handlers), 1)
        line = next(line for line in self.plugin.splitlines() if 'tag=Fitness.DeepSeek.VTT,' in line)
        pattern = line.split(' ', 2)[1]
        segment = ('https://hls-svod.itunes.apple.com/itunes-assets/HLSVideo126/v4/a/course/'
                   'P123_A456_en_subtitles_V2-0.webvtt')
        for url in (segment, segment + '?token=example', segment + '?__loon_fitness_zh=1'):
            self.assertRegex(url, pattern)
        for url in (segment.replace('_en_', '_fr_'), segment.replace('/itunes-assets/', '/music/')):
            self.assertIsNone(re.search(pattern, url))
        self.assertEqual(self.files['loon/apple-video-subtitles-f1-experimental.plugin'], self.plugin)

    def test_remote_assets_are_content_addressed_and_reproducible(self):
        urls = set(re.findall(r'script-path=(https://raw.githubusercontent.com/julianaexx/apple-video-subtitles/[^,\s]+)', self.plugin))
        self.assertEqual(len(urls), 2)
        for url in urls:
            filename = url.rsplit('/', 1)[1]
            content = self.files['scripts/' + filename]
            digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
            self.assertTrue(filename.endswith('-' + digest + '.js'))
        self.assertEqual(self.files, release_files(ROOT / 'config/release.json'))


if __name__ == '__main__':
    unittest.main()
