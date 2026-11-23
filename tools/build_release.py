"""Rebuild base, stable and F1 experimental plugins without changing public files."""
import argparse
import hashlib
import json
from pathlib import Path

from generate_loon import ROOT, generate
from build_deepseek_plugin import build as deepseek
from build_f1_cc_plugin import build as f1, runtime
from build_fitness_plugin import add_course


def release(config_path, output):
    config = json.loads(config_path.read_text(encoding='utf-8'))
    files, _ = generate()
    base = files['apple-video-subtitles.plugin']
    for profile in config['static_courses']:
        base = add_course(base, profile['ids'], profile['donor'], profile['subtitle_base'])
    stable = deepseek(base, config['fitness_script_url'])
    experiment = f1(stable, config['f1_script_url'])
    for name, text in {'base/apple-video-subtitles.plugin':files['apple-video-subtitles.plugin'],
                       'loon/apple-video-subtitles.plugin':stable,
                       'loon/apple-video-subtitles-f1-experimental.plugin':experiment,
                       'scripts/fitness-deepseek.js':(ROOT/'tools/fitness_deepseek.js').read_text(encoding='utf-8'),
                       'scripts/f1-cc-deepseek.js':runtime()}.items():
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
        for name in ['loon/apple-video-subtitles.plugin','loon/apple-video-subtitles-f1-experimental.plugin',
                     'scripts/fitness-deepseek.js','scripts/f1-cc-deepseek.js']:
            if (ROOT/name).read_bytes() != (args.output/name).read_bytes():
                parser.exit(1, f'Rebuilt artifact differs from published artifact: {name}\n')
        print('All four published plugins/scripts reproduced exactly')
    else:
        print('Release artifacts built in ' + str(args.output))
