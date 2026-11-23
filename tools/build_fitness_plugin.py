"""Add one captured Fitness+ course to the single-file Loon plugin."""

import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from zipfile import ZipFile

from generate_loon import OUTPUT
from prepare_subtitles import prepare
from subtitle_hls import playlist

MASTER = "https://play.itunes.apple.com/WebObjects/MZPlay.woa/hls/fitness/playlist.m3u8"
SUBTITLE_HOST = "hls-svod.itunes.apple.com"


def course(capture):
    results = []
    with ZipFile(capture) as archive:
        for item in archive.infolist():
            if not item.filename.endswith("/request_header_raw.txt") or item.file_size > 65536:
                continue
            header = archive.read(item).decode("utf-8", errors="replace")
            authority = re.search(r"(?m)^:authority:\s*([^\s]+)", header)
            url = re.search(r"(?m)^:path:\s*([^\s]+)", header)
            if not authority or authority[1] != "play.itunes.apple.com" or not url:
                continue
            parts = urlsplit(url[1])
            if parts.path != urlsplit(MASTER).path:
                continue
            ids = dict(re.findall(r"(?:^|&)(a|id)=([0-9]+)(?=&|$)", parts.query))
            if set(ids) != {"a", "id"}:
                continue
            try:
                body_entry = archive.getinfo(item.filename.rsplit("/", 1)[0] + "/response_body_raw")
            except KeyError:
                continue
            if body_entry.file_size > 2 * 1024 * 1024:
                continue
            body = archive.read(body_entry).decode("utf-8-sig")
            if not body.startswith("#EXTM3U") or "#EXT-X-STREAM-INF:" not in body:
                continue
            for line in body.splitlines():
                if not line.startswith("#EXT-X-MEDIA:TYPE=SUBTITLES,") or 'LANGUAGE="en"' not in line:
                    continue
                uri = re.search(r'URI="([^"]+)"', line)
                if not uri:
                    continue
                donor = urlsplit(uri[1])
                filename = f"P{ids['id']}_A{ids['a']}_en_subtitles_V2.m3u8"
                if (donor.scheme == "https" and donor.netloc == SUBTITLE_HOST and not donor.query and not donor.fragment
                        and donor.path.rsplit("/", 1)[-1] == filename):
                    results.append((ids, uri[1], body))
    identities = {(ids["id"], ids["a"], donor) for ids, donor, _ in results}
    if len(identities) != 1:
        raise ValueError("capture must include a single Fitness+ master with an independent English subtitle track")
    return results[0]


def rules_for(ids, donor, subtitle_base):
    def quoted(value):
        return json.dumps(value, ensure_ascii=False)

    pattern = "^" + re.escape(MASTER)
    for key in ("a", "id"):
        pattern += rf"(?=\?(?:[^&#]*&)*{key}={ids[key]}(?:&|$))"
    pattern += r"\?[^#]*$"
    base = subtitle_base.rstrip("/") + "/"
    remote = urlsplit(base)
    if (remote.scheme != "https" or not remote.hostname or remote.query or remote.fragment
            or remote.username or remote.password or re.search(r'[\s"\\]', base)):
        raise ValueError("subtitle base must be a public HTTPS directory URL")
    group = "subtitles"
    track = (f'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="{group}",NAME="简体中文",LANGUAGE="zh-Hans",'
             f'DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,STABLE-RENDITION-ID="loonz{ids["a"]}",URI="{base}index.m3u8"')
    # Match the captured donor and keep its entire line. Append our track in the same group.
    donor_pattern = (r'(?m)^#EXT-X-MEDIA:TYPE=SUBTITLES,(?=[^\r\n]*GROUP-ID="subtitles")'
                     r'(?=[^\r\n]*LANGUAGE="en")(?=[^\r\n]*URI="' + re.escape(donor) + r'")[^\r\n]*')
    regex = lambda value: "/" + value.replace("/", r"\/") + "/"
    rules = [f'# Fitness+ course {ids["a"]}: remote Chinese subtitle rendition',
             'response if ${url} ~= ' + regex(pattern) + ' && ${response.status} == 200 then '
             + 'response.body.replace(' + regex(donor_pattern) + ', ' + quoted('$0\n' + track) + ')']
    return rules, pattern, donor_pattern, track


def build(base, capture, source, translations, subtitle_base):
    ids, donor, master = course(capture)
    files = prepare(source, translations)
    english = playlist(source.read_text(encoding="utf-8-sig"))
    prefix = urlsplit(donor).path.rsplit("/", 1)[-1].removesuffix(".m3u8")
    if any(name != f"{prefix}-{index}.webvtt" for index, (_, name) in enumerate(english.segments, english.sequence)):
        raise ValueError("source subtitle segments do not belong to the captured Fitness+ course")
    rules, _, donor_pattern, _ = rules_for(ids, donor, subtitle_base)
    if len(re.findall(donor_pattern, master)) != 1 or any(
            'SUBTITLES="subtitles"' not in line for line in master.splitlines() if line.startswith("#EXT-X-STREAM-INF:")):
        raise ValueError("captured master does not match the supported Fitness+ subtitle layout")
    return add_course(base, ids, donor, subtitle_base)


def add_course(base, ids, donor, subtitle_base):
    """Build from a public course profile, without needing its private capture."""
    rules, _, _, _ = rules_for(ids, donor, subtitle_base)
    lines = base.splitlines()
    at = lines.index("[Rewrite]") + 1
    lines[at:at] = rules + [""]
    hostname = next(i for i, line in enumerate(lines) if line.startswith("hostname = "))
    for host in ("play.itunes.apple.com",):
        if host not in lines[hostname].partition(" = ")[2].split(", "):
            lines[hostname] += ", " + host
    lines[0] += " + Fitness+"
    lines[1] += f"，新增 Fitness+ 课程 {ids['a']}（Rewrite V2）"
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("source", type=Path)
    parser.add_argument("translations", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--base", type=Path, default=OUTPUT / "apple-video-subtitles.plugin")
    parser.add_argument("--subtitle-base", required=True, help="public HTTPS directory containing index.m3u8 and VTT segments")
    parser.add_argument("--assets-dir", type=Path, required=True, help="new directory for publishing Chinese subtitle assets")
    args = parser.parse_args()
    if args.output.resolve() == args.base.resolve():
        parser.error("use a distinct output file for the Fitness+ build")
    try:
        if args.assets_dir.exists():
            raise ValueError("assets directory already exists; choose a new destination")
        translations = json.loads(args.translations.read_text(encoding="utf-8"))
        result = build(args.base.read_text(encoding="utf-8-sig"), args.capture, args.source,
                       translations, args.subtitle_base)
        files = prepare(args.source, translations)
        args.assets_dir.mkdir(parents=True)
        for name, text in files.items():
            (args.assets_dir / name).write_bytes(text.encode("utf-8"))
        args.output.write_bytes(result.encode("utf-8"))
        print(f"Wrote {args.output}")
    except (ValueError, OSError) as error:
        parser.exit(1, f"Fitness+ build failed: {error}\n")


if __name__ == "__main__":
    main()
