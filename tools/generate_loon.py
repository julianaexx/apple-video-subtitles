"""Generate the local Loon plugin from the active Surge module (Python 3.10+)."""

import argparse
import json
import hashlib
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys

from local_catalog import compile_catalog

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "surge/apple-video-subtitles.sgmodule"
OUTPUT = ROOT / "build/base"
LOCAL_CATALOG = ROOT / "local/catalog.json"
UTS_TAG = "AppleTV.Movie.SafeBridgeFull.UTS.response"
PINNED_URL = re.compile(
    r"https://raw\.githubusercontent\.com/rexchen1803/apple-video-subtitles/"
    r"([0-9a-f]{40})/(payloads/surge/[A-Za-z0-9_./-]+\.js)"
)


def subtitle_url(url):
    """Serve exact upstream bytes from our versioned, append-only mirror."""
    match = PINNED_URL.fullmatch(url)
    if not match or '..' in match[2].split('/'):
        raise ValueError('invalid pinned subtitle URL')
    config = json.loads((ROOT / 'config/release.json').read_text(encoding='utf-8'))
    return config['subtitle_base_url'].rstrip('/') + '/' + match[1] + '/' + match[2]


@dataclass
class Rule:
    tag: str
    options: dict[str, str]


def parse_module(text):
    metadata, hosts, rules = {}, [], []
    section = None
    seen_sections, tags = set(), set()
    allowed = {"type", "pattern", "requires-body", "timeout", "script-path", "max-size"}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#!"):
            key, sep, value = line[2:].partition("=")
            if not sep or key not in {"name", "desc", "author", "homepage", "date", "icon"} or key in metadata:
                raise ValueError(f"line {number}: unsupported or duplicate metadata")
            metadata[key] = value
        elif line.startswith("#"):
            continue
        elif line.startswith("["):
            if line not in {"[MITM]", "[Script]"} or line in seen_sections:
                raise ValueError(f"line {number}: unsupported or duplicate section {line}")
            section = line
            seen_sections.add(line)
        elif section == "[MITM]":
            if hosts or not line.startswith("hostname = %APPEND% "):
                raise ValueError(f"line {number}: expected one appended MITM hostname list")
            hosts = [host.strip() for host in line.split("%APPEND% ", 1)[1].split(",")]
            if any(not re.fullmatch(r"(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", host) for host in hosts):
                raise ValueError(f"line {number}: invalid MITM host")
        elif section == "[Script]":
            tag, sep, fields = line.partition(" = ")
            if not sep or not re.fullmatch(r"[A-Za-z0-9_.-]+", tag) or tag in tags:
                raise ValueError(f"line {number}: invalid or duplicate script tag")
            options = {}
            for field in re.split(r",(?=[A-Za-z][A-Za-z0-9-]*\s*=)", fields):
                key, sep, value = field.partition("=")
                key = key.strip()
                if not sep or key not in allowed or key in options or not value:
                    raise ValueError(f"line {number}: unsupported or duplicate option {key!r}")
                options[key] = value
            if not allowed.difference({"max-size"}).issubset(options):
                raise ValueError(f"line {number}: missing script options")
            if options["type"] not in {"http-request", "http-response"} or options["requires-body"] not in {"0", "1"}:
                raise ValueError(f"line {number}: unsupported script type/body setting")
            for key in ("timeout", "max-size"):
                if key in options and not re.fullmatch(r"[1-9][0-9]*", options[key]):
                    raise ValueError(f"line {number}: invalid {key}")
            if not PINNED_URL.fullmatch(options["script-path"]):
                raise ValueError(f"line {number}: script URL must pin an upstream commit")
            if options["type"] == "http-response":
                if tag != UTS_TAG or options["requires-body"] != "1" or "max-size" not in options:
                    raise ValueError(f"line {number}: new response rule needs explicit review")
            elif "max-size" in options:
                raise ValueError(f"line {number}: request max-size is not supported")
            if re.search(r"\s", options["pattern"]):
                raise ValueError(f"line {number}: whitespace in pattern is not supported")
            tags.add(tag)
            rules.append(Rule(tag, options))
        else:
            raise ValueError(f"line {number}: unexpected content")
    if not hosts or not rules or "name" not in metadata or "desc" not in metadata:
        raise ValueError("module is missing required metadata, hosts, or rules")
    if sum(rule.options["type"] == "http-response" for rule in rules) != 1:
        raise ValueError("expected exactly one UTS response rule")
    return metadata, hosts, rules


def pinned_source(url):
    match = PINNED_URL.fullmatch(url)
    revision, path = match.groups()
    if ".." in path.split("/"):
        raise ValueError("invalid upstream path")
    result = subprocess.run(
        ["git", "show", f"{revision}:{path}"], cwd=ROOT, capture_output=True
    )
    if result.returncode == 0:
        raw = result.stdout
    else:
        bundled = ROOT / "vendor/pinned" / revision / path
        manifest_path = ROOT / "vendor/pinned-manifest.json"
        if not bundled.is_file() or not manifest_path.is_file():
            raise ValueError(f"missing pinned source {revision}:{path}; refresh the vendored upstream sources")
        raw = bundled.read_bytes()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        expected = manifest["files"].get(revision + "/" + path, {}).get("sha256")
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError(f"pinned source checksum mismatch: {revision}:{path}")
    return raw.decode("utf-8").replace("\r\n", "\n")


def static_catalog():
    """Use the same pinned catalog for the jq base and unified JS runtime."""
    _, _, rules = parse_module(SOURCE.read_text(encoding="utf-8-sig"))
    response = next(rule for rule in rules if rule.options["type"] == "http-response")
    source = pinned_source(response.options["script-path"])
    catalog = {}
    for name, key in (("replayConfigs", "previews"), ("shelfRevisions", "revisions"),
                      ("targets", "movies"), ("seriesTargets", "series"), ("f1Replays", "replays")):
        match = re.search(r"^const " + name + r" = (.+);$", source, re.M)
        if not match:
            raise ValueError(f"UTS catalog changed: missing {name}; review the Loon rewrite")
        catalog[key] = json.loads(match[1])
    # Preview injection needs only these fields, not the large recorded manifests.
    catalog['previews'] = [{key: row[key] for key in ('referenceId', 'masterPath', 'revision')}
                           for row in catalog['previews']]
    return catalog


def generate(local_catalog=LOCAL_CATALOG):
    metadata, hosts, rules = parse_module(SOURCE.read_text(encoding="utf-8-sig"))
    custom_rules, custom_hosts, _ = compile_catalog(local_catalog)
    # Validate every pinned resource, including the response script, before writing.
    for url in sorted({rule.options["script-path"] for rule in rules}):
        pinned_source(url)
    response = next(rule for rule in rules if rule.options["type"] == "http-response")
    catalog = static_catalog()
    template = (ROOT / "tools/loon-uts.jq").read_text(encoding="utf-8")
    jq = " ".join(line.strip() for line in template.splitlines() if line.strip())
    jq = jq.replace("__CATALOG__", json.dumps(catalog, ensure_ascii=False, separators=(",", ":")))
    if "'" in jq:
        raise ValueError("embedded jq contains a single quote that would break the Loon rule")
    lines = [
        "#!name=" + metadata["name"] + "（Loon）",
        "#!desc=" + metadata["desc"] + "；单文件版，需要 Loon Build 729 或更新版本",
        "", "# Generated by tools/generate_loon.py. Do not edit.",
        "# The UTS rewrite is embedded using Loon's response-body-json-jq action.",
        "", "[Rewrite]",
        f"{response.options['pattern']} response-body-json-jq '{jq}'",
        "", "[Script]",
    ]
    for rule in rules:
        o = rule.options
        if o["type"] == "http-response":
            continue
        script = subtitle_url(o["script-path"])
        lines.append(
            f'{o["type"]} {o["pattern"]} script-path={script},'
            f'timeout={o["timeout"]},tag={rule.tag},enable=true'
        )
    lines.extend(custom_rules)
    lines.extend(["", "[MITM]", "hostname = " + ", ".join(dict.fromkeys(hosts + custom_hosts)), ""])
    return {"apple-video-subtitles.plugin": "\n".join(lines)}, len(rules) + len(custom_rules)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify generated files without writing")
    parser.add_argument("--verify-resources", action="store_true", help="download and compare all scripts with pinned Git sources")
    parser.add_argument("--catalog", type=Path, default=LOCAL_CATALOG, help="custom program catalog JSON")
    parser.add_argument("--output-dir", type=Path, default=OUTPUT, help="destination for the generated plugin")
    args = parser.parse_args()
    try:
        outputs, count = generate(args.catalog)
        if args.verify_resources:
            from repair_loon_resources import verify
            _, _, expected = compile_catalog(args.catalog)
            resources = verify(outputs["apple-video-subtitles.plugin"], expected)
            print(f"Verified {len(resources)} remote resources against pinned Git sources")
        if args.check:
            stale = [name for name, text in outputs.items() if not (args.output_dir / name).is_file()
                     or (args.output_dir / name).read_bytes() != text.encode("utf-8")]
            if stale:
                raise ValueError("missing or stale generated files: " + ", ".join(stale))
        else:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            for name, text in outputs.items():
                (args.output_dir / name).write_bytes(text.encode("utf-8"))
        print(f"Loon: {count} rules; {len(outputs)} files {'verified' if args.check else 'generated'}")
    except (ValueError, OSError, UnicodeError) as error:
        print(f"Loon generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
