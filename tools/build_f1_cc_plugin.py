"""Build a separate generic F1 CC experiment without replacing stable Fitness+."""
import argparse
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def runtime():
    return ((ROOT / "tools/f1_cc608.js").read_text(encoding="utf-8") + "\n"
            + (ROOT / "tools/f1_cc_runtime.js").read_text(encoding="utf-8"))


def build(base, script_url):
    if not re.fullmatch(r"https://[^\s,\"{}]+\.js", script_url):
        raise ValueError("invalid runtime URL")
    if "F1.CC.Master" in base:
        raise ValueError("already includes the F1 CC experiment")
    lines = base.splitlines()
    at = lines.index("[Script]") + 1
    arguments = ',argument={deepseek_key,deepseek_model,deepseek_wait},enable=true'
    linear = r'linear-(?:ak|ap|fa)-[a-z0-9-]+\.tv\.apple\.com'
    content = r'\/Content\/HLS_CBC\/CatchUp\/Channel\([^\s]+\/Stream\(\d+\)\/'
    rules = [
        r'http-response ^https:\/\/uts-api\.itunes\.apple\.com\/uts\/(?:v1|v2|v3)\/ '
        + 'script-path=' + script_url + ',requires-body=true,max-size=2097152,timeout=2,tag=F1.CC.Register' + arguments,
        r'http-response ^https:\/\/' + linear + content + r'[^\s?]*\.m3u8(?:\?.*)?$ '
        + 'script-path=' + script_url + ',requires-body=true,max-size=2097152,timeout=2,tag=F1.CC.Media' + arguments,
        r'http-response ^https:\/\/' + linear + content + r'Segment\(\d+\)\.m4v(?:\?.*)?$ '
        + 'script-path=' + script_url + ',requires-body=true,binary-body-mode=true,max-size=12582912,timeout=2,tag=F1.CC.Observe' + arguments,
        r'http-request ^https:\/\/hls-amt\.itunes\.apple\.com\/__loon_f1_cc\/v1\/(?:[a-f0-9]+\/(?:master|index)\.m3u8|segment\.vtt\?src=[^&]+)$ '
        + 'script-path=' + script_url + ',timeout=18,tag=F1.CC.Subtitles' + arguments,
    ]
    lines[at:at] = rules + ['']
    index = next(i for i, line in enumerate(lines) if line.startswith('hostname = '))
    for host in ('linear-ak-p-har-prod-a.tv.apple.com',
                 'linear-ap-p-har-prod-a.tv.apple.com', 'linear-fa-p-har-prod-a.tv.apple.com',
                 ):
        if host not in lines[index].partition(' = ')[2].split(', '):
            lines[index] += ', ' + host
    lines[0] = '#!name=Apple TV 中文字幕 + F1 CC DeepSeek 实验'
    lines[1] = '#!desc=f1cc-20261123b；F1 回放 CC 通用翻译修正版，避开许可证主机解密，主列表失败退回原播放；保留已验证 Fitness+'
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--script-url', required=True)
    parser.add_argument('--runtime-output', type=Path, required=True)
    args = parser.parse_args()
    plugin = build(args.base.read_text(encoding='utf-8-sig'), args.script_url)
    args.runtime_output.write_bytes(runtime().encode('utf-8'))
    args.output.write_bytes(plugin.encode('utf-8'))
