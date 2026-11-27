"""Portable project checks; run after cloning the development repository."""
import argparse
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jq', help='optional jq executable for the embedded jq regression')
    args = parser.parse_args()
    commands = [
        [sys.executable, '-B', 'tools/build_release.py', '--check-published'],
        [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tools', '-p', 'test_*.py'],
        ['node', 'tools/test_loon.mjs'],
        ['node', 'tools/test_inject_subtitles.mjs'],
        ['node', 'tools/test_fitness_deepseek.mjs'],
        ['node', 'tools/test_translation_service.mjs'],
        ['node', 'tools/test_f1_cc.mjs'],
        ['node', 'tools/test_tvos_deepseek.mjs'],
        ['node', 'tools/test_tvos_deepseek.mjs', '--native'],
    ]
    env = os.environ.copy()
    if args.jq:
        env['APPLE_SUBTITLES_JQ'] = args.jq
        commands.append(['node', 'tools/test_loon_jq.mjs'])
    for command in commands:
        print('Running: ' + ' '.join(command), flush=True)
        subprocess.run(command, cwd=ROOT, env=env, check=True)
    print('Development checks passed. No plugin changes have been published.')
