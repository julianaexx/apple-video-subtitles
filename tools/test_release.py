"""Regression checks for the Music-safe single-plugin release."""
import hashlib
import json
import re
import unittest

from build_release import release_files
from generate_loon import ROOT
from build_deepseek_plugin import TRANSLATION_ARGUMENTS


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
        self.assertIn('f1_wait = input,15,', self.plugin)
        f1_rules = [line for line in self.plugin.splitlines() if 'tag=F1.CC.' in line]
        self.assertTrue(all('argument={' + TRANSLATION_ARGUMENTS + ',f1_wait}' in line for line in f1_rules))
        native = next(line for line in f1_rules if 'tag=F1.CC.NativeVTT,' in line)
        pattern = native.split(' ', 2)[1]
        sample = ('https://hls-amt.itunes.apple.com/itunes-assets/HLSSportsVodVideo211/v4/aa/bb/cc/test/'
                  'P1560312730_A6837919154_en_subtitles_V2-0.webvtt')
        self.assertRegex(sample, pattern)
        self.assertRegex(sample + '?token=test', pattern)
        for url in (sample.replace('_en_', '_es_'), sample.replace('.webvtt', '.m4s'),
                    sample.replace('HLSSportsVodVideo211', 'HLSVideo211')):
            self.assertIsNone(re.search(pattern, url))
        self.assertIn('requires-body=true,max-size=65536,timeout=18,', native)
        self.assertIn('translation_provider = select,"deepseek","volcengine"', self.plugin)
        for argument in ('volc_access_key_id', 'volc_secret_access_key'):
            self.assertIn(argument + ' = input,""', self.plugin)
        line = next(line for line in self.plugin.splitlines() if 'tag=Fitness.DeepSeek.VTT,' in line)
        self.assertNotIn('f1_wait', line)
        self.assertIn('argument={' + TRANSLATION_ARGUMENTS + '}', line)
        pattern = line.split(' ', 2)[1]
        segment = ('https://hls-svod.itunes.apple.com/itunes-assets/HLSVideo126/v4/a/course/'
                   'P123_A456_en_subtitles_V2-0.webvtt')
        for url in (segment, segment + '?token=example', segment + '?__loon_fitness_zh=1'):
            self.assertRegex(url, pattern)
        for url in (segment.replace('_en_', '_fr_'), segment.replace('/itunes-assets/', '/music/')):
            self.assertIsNone(re.search(pattern, url))
        self.assertEqual(self.files['loon/apple-video-subtitles-f1-experimental.plugin'], self.plugin)

    def test_remote_assets_are_content_addressed_and_reproducible(self):
        urls = set(re.findall(r'script-path=(https://raw.githubusercontent.com/julianaexx/apple-video-subtitles/main/scripts/[^,\s]+)', self.plugin))
        self.assertEqual(len(urls), 2)
        for url in urls:
            filename = url.rsplit('/', 1)[1]
            content = self.files['scripts/' + filename]
            digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
            self.assertTrue(filename.endswith('-' + digest + '.js'))
        self.assertEqual(self.files, release_files(ROOT / 'config/release.json'))

    def test_static_subtitles_are_complete_and_served_by_our_repository(self):
        urls = set(re.findall(r'script-path=(https://[^,\s]+)', self.plugin))
        prefix = 'https://raw.githubusercontent.com/julianaexx/apple-video-subtitles/main/'
        manifest = json.loads((ROOT / 'vendor/pinned-manifest.json').read_text())['files']
        for url in urls:
            self.assertTrue(url.startswith(prefix), url)
            path = url[len(prefix):]
            data = (ROOT / path).read_bytes() if path.startswith('vendor/') else self.files[path].encode('utf-8')
            if path.startswith('vendor/pinned/'):
                expected = manifest[path[len('vendor/pinned/'):]]
                self.assertEqual(len(data), expected['bytes'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), expected['sha256'])
                self.assertNotRegex(data.decode('utf-8'), r'https?://[^\s\x22\x27]*rexchen1803')
        for tag in ('F1.Replay.20-sao-paulo.Track.Vtt.request', 'F1.Preview.LV.VTT.request'):
            self.assertIn('tag=' + tag + ',', self.plugin)


if __name__ == '__main__':
    unittest.main()
