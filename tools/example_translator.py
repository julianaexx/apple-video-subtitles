"""Offline demo only: JSON cue strings on stdin, translated JSON strings on stdout."""
import json
import sys

DEMO = {"Brake now": "现在刹车", "Keep your shoulders relaxed": "保持肩膀放松"}

if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    texts = json.load(sys.stdin)
    try:
        json.dump([DEMO[text] for text in texts], sys.stdout, ensure_ascii=False)
    except KeyError:
        sys.exit("Demo translator only supports the bundled sample cues; configure a real translator for actual content")
