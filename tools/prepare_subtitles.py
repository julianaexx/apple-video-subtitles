"""Prepare Chinese HLS sidecars from a local English WebVTT playlist."""

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit

from subtitle_hls import playlist, translate_vtt, vtt


def segment_path(folder, uri):
    url = urlsplit(uri)
    if url.scheme or url.netloc or url.query or url.fragment:
        raise ValueError("use downloaded subtitle segments with relative local paths")
    target = (folder / unquote(url.path)).resolve()
    if not target.is_relative_to(folder.resolve()):
        raise ValueError("subtitle path escapes input folder")
    return target


def cue_key(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract(source):
    media = playlist(source.read_text(encoding="utf-8-sig"))
    cues = {}
    for _, uri in media.segments:
        _, rows = vtt(segment_path(source.parent, uri).read_text(encoding="utf-8-sig"))
        for _, _, text in rows:
            cues[cue_key(text)] = {"source": text, "translation": ""}
    return {"version": 1, "cues": cues}


def prepare(source, translations):
    media = playlist(source.read_text(encoding="utf-8-sig"))
    if not media.ended:
        raise ValueError("point-in-time VOD preparation requires EXT-X-ENDLIST; use live_subtitles.py for live")
    if translations.get("version") != 1 or not isinstance(translations.get("cues"), dict):
        raise ValueError("unsupported translation map")

    def translate(texts):
        result = []
        for text in texts:
            row = translations["cues"].get(cue_key(text), {})
            if (not isinstance(row, dict) or row.get("source") != text
                    or not isinstance(row.get("translation"), str) or not row["translation"].strip()):
                raise ValueError(f"missing translation for cue {cue_key(text)}")
            result.append(row["translation"])
        return result

    files = {}
    for index, (_, uri) in enumerate(media.segments):
        name = f"seg-{index:06d}.vtt"
        files[name] = translate_vtt(segment_path(source.parent, uri).read_text(encoding="utf-8-sig"), translate)
    files["index.m3u8"] = media.render(files.keys())
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--extract", type=Path, help="write cue translation worksheet JSON")
    group.add_argument("--translations", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        if args.extract:
            if args.extract.exists():
                raise ValueError("translation worksheet already exists")
            args.extract.write_text(json.dumps(extract(args.source), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        else:
            if not args.output or args.output.exists():
                raise ValueError("provide a new --output folder (existing data is never overwritten)")
            files = prepare(args.source, json.loads(args.translations.read_text(encoding="utf-8")))
            args.output.mkdir(parents=True)
            for name, text in files.items():
                (args.output / name).write_text(text, encoding="utf-8", newline="\n")
        print("Subtitle preparation complete")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Subtitle preparation failed: {error}\n")


if __name__ == "__main__":
    main()
