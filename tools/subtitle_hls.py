"""Read HLS WebVTT renditions and replace only cue text."""

from dataclasses import dataclass
from decimal import Decimal
import re


@dataclass(frozen=True)
class Playlist:
    lines: list[str]
    segments: tuple[tuple[int, str], ...]
    sequence: int
    target_duration: int
    ended: bool

    def render(self, names):
        if len(names) != len(self.segments):
            raise ValueError("segment count does not match playlist")
        lines = self.lines.copy()
        for (index, _), name in zip(self.segments, names):
            lines[index] = name
        return "\n".join(lines) + "\n"


def playlist(text):
    lines = text.removeprefix("\ufeff").splitlines()
    if not lines or lines[0] != "#EXTM3U":
        raise ValueError("expected an HLS media playlist")
    if any(line.startswith(("#EXT-X-KEY:", "#EXT-X-MAP:", "#EXT-X-BYTERANGE:",
                            "#EXT-X-STREAM-INF:", "#EXT-X-PART", "#EXT-X-PRELOAD-HINT:",
                            "#EXT-X-SKIP:", "#EXT-X-DEFINE:", "#EXT-X-RENDITION-REPORT:"))
           or line == "#EXT-X-GAP" for line in lines):
        raise ValueError("expected unencrypted, standalone WebVTT segments in a full HLS playlist")
    sequence, duration = 0, None
    segments, pending = [], False
    for index, line in enumerate(lines[1:], 1):
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            sequence = int(line.partition(":")[2])
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            duration = int(line.partition(":")[2])
        elif line.startswith("#EXTINF:"):
            value = line.partition(":")[2].split(",", 1)[0]
            if pending or not re.fullmatch(r"\d+(?:\.\d+)?", value) or Decimal(value) <= 0:
                raise ValueError("invalid EXTINF")
            pending = True
        elif line and not line.startswith("#"):
            if not pending:
                raise ValueError("segment without EXTINF")
            segments.append((index, line))
            pending = False
    if sequence < 0 or not duration or duration < 0 or pending or not segments:
        raise ValueError("incomplete HLS media playlist")
    return Playlist(lines, tuple(segments), sequence, duration, "#EXT-X-ENDLIST" in lines)


TIMING = re.compile(r"^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}(?:\s.*)?$")


def vtt(text):
    blocks = re.split(r"\n{2,}", text.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip("\n"))
    if not blocks or not re.match(r"^WEBVTT(?:[ \t].*)?(?:\n|$)", blocks[0]):
        raise ValueError("expected a standalone WEBVTT segment")
    cues = []
    for index, block in enumerate(blocks[1:], 1):
        if re.match(r"^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)", block.split("\n", 1)[0]):
            continue
        lines = block.split("\n")
        offset = 0 if TIMING.fullmatch(lines[0]) else 1
        if len(lines) <= offset or not TIMING.fullmatch(lines[offset]):
            raise ValueError("invalid WebVTT cue timing")
        cues.append((index, "\n".join(lines[:offset + 1]), "\n".join(lines[offset + 1:])))
    return blocks, cues


def translate_vtt(text, translate):
    blocks, cues = vtt(text)
    replacements = translate([cue for _, _, cue in cues]) if cues else []
    if (not isinstance(replacements, list) or len(replacements) != len(cues)
            or any(not isinstance(value, str) or not value.strip() or "-->" in value
                   or "\r" in value or any(not line.strip() for line in value.split("\n"))
                   for value in replacements)):
        raise ValueError("translations must contain one nonempty cue text per input cue")
    for (index, timing, _), replacement in zip(cues, replacements):
        blocks[index] = timing + "\n" + replacement
    return "\n\n".join(blocks) + "\n\n"
