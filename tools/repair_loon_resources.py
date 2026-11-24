"""Repair missing script URLs using matching rules in the upstream Surge module."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.request import urlopen

from generate_loon import ROOT, SOURCE, PINNED_URL, parse_module, pinned_source, subtitle_url

CDN = re.compile(
    r"https://cdn\.jsdelivr\.net/gh/rexchen1803/apple-video-subtitles@"
    r"([a-f0-9]{40})/(payloads/surge/[A-Za-z0-9_./-]+\.js)"
)


def mirror_match(url):
    base = json.loads((ROOT / 'config/release.json').read_text(encoding='utf-8'))['subtitle_base_url']
    return re.fullmatch(re.escape(base.rstrip('/') + '/') +
                        r'([a-f0-9]{40})/(payloads/surge/[A-Za-z0-9_./-]+\.js)', url)


def git_source(url):
    match = mirror_match(url) or CDN.fullmatch(url) or PINNED_URL.fullmatch(url)
    if not match or ".." in match[2].split("/"):
        raise ValueError(f"Unsupported script URL: {url}")
    raw = f"https://raw.githubusercontent.com/rexchen1803/apple-video-subtitles/{match[1]}/{match[2]}"
    try:
        return pinned_source(raw).encode("utf-8")
    except ValueError:
        return None


def repair(text):
    _, _, upstream = parse_module(SOURCE.read_text(encoding="utf-8-sig"))
    by_pattern = {r.options["pattern"]: r.options["script-path"] for r in upstream}
    changes = []

    def replace_rule(match):
        line = match[0]
        pattern = line.split()[1]
        script = re.search(r"script-path=(https://[^,\s]+)", line)
        if not script:
            raise ValueError("Rule without script-path")
        old = script[1]
        if git_source(old) is not None:
            return line
        raw = by_pattern.get(pattern)
        if raw is None:
            raise ValueError(f"No upstream rule matches missing resource: {old}")
        new = subtitle_url(raw)
        if git_source(new) is None:
            raise ValueError(f"Replacement missing in Git: {new}")
        changes.append({"old": old, "new": new})
        return line[:script.start(1)] + new + line[script.end(1):]

    fixed = re.sub(r"^http-(?:request|response) [^\r\n]+", replace_rule, text, flags=re.M)
    return fixed, changes


def verify(text, expected_scripts=None):
    expected_scripts = expected_scripts or {}
    urls = sorted(set(re.findall(r"(?:script-path|#!icon\s*)\s*=\s*(https://[^,\s]+)", text)))

    def check(url):
        try:
            response = urlopen(url, timeout=30)
        except OSError as error:
            raise ValueError(f"Resource download failed: {url}: {error}") from error
        with response:
            data = response.read()
            if response.status != 200:
                raise ValueError(f"HTTP {response.status}: {url}")
            if mirror_match(url) or CDN.fullmatch(url) or PINNED_URL.fullmatch(url):
                expected = git_source(url)
                if expected is None or data != expected:
                    raise ValueError(f"Remote script differs from pinned Git source: {url}")
            if url in expected_scripts and data != expected_scripts[url]:
                raise ValueError(f"Remote custom script differs from local source: {url}")
            return {"url": url, "status": response.status, "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest()}

    with ThreadPoolExecutor(max_workers=10) as pool:
        return list(pool.map(check, urls))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--verify-resources", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("Use a separate output file to preserve the original")
    # Preserve original line endings and all configuration other than missing URLs.
    original = args.input.read_bytes()
    fixed, changes = repair(original.decode("utf-8-sig"))
    resources = verify(fixed) if args.verify_resources else []
    args.output.write_bytes(fixed.encode("utf-8"))
    if args.report:
        args.report.write_text(json.dumps({
            "input_sha256": hashlib.sha256(original).hexdigest(),
            "changes": changes, "resources": resources,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Repaired {len(changes)} URLs; verified {len(resources)} resources; wrote {args.output}")


if __name__ == "__main__":
    main()
