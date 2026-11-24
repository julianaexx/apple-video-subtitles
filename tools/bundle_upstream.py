"""Bundle exact upstream build dependencies from a full upstream Git checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def bundle(checkout, destination):
    module = (destination / 'surge/apple-video-subtitles.sgmodule').read_text(encoding='utf-8-sig')
    pairs = sorted(set(re.findall(
        r'https://raw\.githubusercontent\.com/rexchen1803/apple-video-subtitles/([a-f0-9]{40})/(payloads/surge/[\w./-]+\.js)', module)))
    if not pairs:
        raise ValueError('no pinned sources found')
    manifest_path = destination / 'vendor/pinned-manifest.json'
    # Keep historical pins: regression fixtures and older subscriptions may
    # still reference them after the active module advances.
    files = json.loads(manifest_path.read_text(encoding='utf-8'))['files'] if manifest_path.is_file() else {}
    for revision, path in pairs:
        if '..' in path.split('/'):
            raise ValueError('invalid upstream path')
        data = subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=checkout)
        target = destination / 'vendor/pinned' / revision / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files[revision + '/' + path] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    manifest = {'version': 1, 'upstream': 'https://github.com/rexchen1803/apple-video-subtitles', 'files': files}
    manifest_path.write_bytes((json.dumps(manifest, indent=2) + '\n').encode('utf-8'))
    print(f'Bundled {len(pairs)} active dependencies; retained {len(files)} total pinned sources')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream_checkout', type=Path)
    parser.add_argument('--destination', type=Path, default=ROOT)
    args = parser.parse_args()
    bundle(args.upstream_checkout.resolve(), args.destination.resolve())
