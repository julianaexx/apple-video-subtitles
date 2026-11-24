"""Offline conversion checks. Run: python -B -m unittest discover -s tools -p test_loon.py"""

import unittest

import generate_loon as generator


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.source = generator.SOURCE.read_text(encoding="utf-8")

    def test_all_rules_keep_order_patterns_pins_and_timing(self):
        _, hosts, rules = generator.parse_module(self.source)
        outputs, count = generator.generate()
        plugin = outputs["apple-video-subtitles.plugin"]
        lines = [line for line in plugin.splitlines() if line.startswith("http-")]
        self.assertEqual(count, len(rules))
        requests = [rule for rule in rules if rule.options["type"] == "http-request"]
        response = next(rule for rule in rules if rule.options["type"] == "http-response")
        self.assertEqual(len(lines), len(requests))
        self.assertEqual(plugin.count(" response-body-json-jq '"), 1)
        self.assertIn("[Rewrite]\n" + response.options["pattern"] + " response-body-json-jq '", plugin)
        for line, rule in zip(lines, requests):
            kind, pattern, options = line.split(" ", 2)
            parsed = dict(field.split("=", 1) for field in options.split(","))
            self.assertEqual(kind, rule.options["type"])
            self.assertEqual(pattern, rule.options["pattern"])
            self.assertEqual(parsed["tag"], rule.tag)
            self.assertEqual(parsed["timeout"], rule.options["timeout"])
            self.assertNotIn("requires-body", parsed)
            match = generator.PINNED_URL.fullmatch(rule.options["script-path"])
            expected = generator.subtitle_url(rule.options["script-path"])
            self.assertEqual(parsed["script-path"], expected)
        self.assertIn("hostname = " + ", ".join(hosts), plugin)
        self.assertNotIn("%APPEND%", plugin)
        self.assertNotIn("apple-video-subtitles-uts.js", plugin)
        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs, generator.generate()[0])

    def test_upstream_changes_require_review(self):
        mutations = [
            self.source.replace("timeout=30", "unknown-option=30", 1),
            self.source.replace("timeout=30", "timeout=30,timeout=60", 1),
            self.source + "\n[Rule]\nDOMAIN,example.com,DIRECT\n",
            self.source.replace("max-size=2097152", "max-size=zero"),
            self.source.replace("type=http-response", "type=cron"),
            self.source.replace(generator.UTS_TAG, "New.Response"),
            self.source.replace("%APPEND% ", ""),
            self.source.replace("/a040b1ddf317c10b5bcba97e708bce68b1d2eca7/", "/main/"),
        ]
        for text in mutations:
            with self.subTest(text=text[:80]):
                with self.assertRaises(ValueError):
                    generator.parse_module(text)


if __name__ == "__main__":
    unittest.main()
