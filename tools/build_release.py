"""Rebuild the unified plugin, subscription alias and content-addressed runtimes."""
import argparse
import hashlib
import json
from pathlib import Path

from generate_loon import ROOT, generate
from build_deepseek_plugin import build as deepseek
from build_f1_cc_plugin import build as f1, runtime


def release_files(config_path):
    config = json.loads(config_path.read_text(encoding='utf-8'))
    files, _ = generate()
    base = files['apple-video-subtitles.plugin']
    fitness = (ROOT/'tools/fitness_deepseek.js').read_text(encoding='utf-8')
    f1_runtime = runtime()
    # Content-addressed filenames prevent a newly imported plugin from silently
    # downloading the old runtime before the release files have been published.
    assets = {}
    urls = []
    for name, text in [('fitness-deepseek', fitness), ('f1-cc-deepseek', f1_runtime)]:
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        filename = name + '-' + digest + '.js'
        assets['scripts/' + filename] = text
        urls.append(config['runtime_base_url'].rstrip('/') + '/' + filename)
    unified = f1(deepseek(base, urls[0]), urls[1])
    return {'base/apple-video-subtitles.plugin':base,
            'loon/apple-video-subtitles.plugin':unified,
            # Compatibility subscription URL; install only one of these aliases.
            'loon/apple-video-subtitles-f1-experimental.plugin':unified,
            'scripts/fitness-deepseek.js':fitness,
            'scripts/f1-cc-deepseek.js':f1_runtime, **assets}


def release(config_path, output):
    for name, text in release_files(config_path).items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode('utf-8'))
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT/'config/release.json')
    parser.add_argument('--output', type=Path, default=ROOT/'build')
    parser.add_argument('--check-published', action='store_true')
    args = parser.parse_args()
    if args.output.resolve() == ROOT.resolve():
        parser.error('build output must not overwrite repository root')
    release(args.config, args.output)
    if args.check_published:
        for name in release_files(args.config):
            if name.startswith('base/'):
                continue
            if not (ROOT/name).is_file():
                parser.exit(1, f'Missing release artifact: {name}\n')
            if (ROOT/name).read_bytes() != (args.output/name).read_bytes():
                parser.exit(1, f'Rebuilt artifact differs from published artifact: {name}\n')
        print('All release plugins/scripts reproduced exactly (publication is a separate step)')
    else:
        print('Release artifacts built in ' + str(args.output))
