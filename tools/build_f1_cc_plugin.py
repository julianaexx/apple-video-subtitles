"""Add generic F1 CC and a single static/AI UTS dispatcher to Loon."""
import argparse
import json
from pathlib import Path
import re
from generate_loon import static_catalog
from build_deepseek_plugin import TRANSLATION_ARGUMENTS

ROOT = Path(__file__).resolve().parents[1]


def runtime():
    catalog = json.dumps(static_catalog(), ensure_ascii=False, separators=(',', ':'))
    return ((ROOT / 'tools/translation_service.js').read_text(encoding='utf-8') + '\n'
            + 'const APPLE_STATIC_CATALOG = ' + catalog + ';\n'
            + (ROOT / "tools/uts_static.js").read_text(encoding="utf-8") + '\n'
            + (ROOT / "tools/f1_cc608.js").read_text(encoding="utf-8") + "\n"
            + (ROOT / "tools/f1_cc_runtime.js").read_text(encoding="utf-8"))


def build(base, script_url):
    if not re.fullmatch(r"https://[^\s,\"{}]+\.js", script_url):
        raise ValueError("invalid runtime URL")
    if "tag=F1.CC." in base:
        raise ValueError("already includes the F1 CC experiment")
    lines = base.splitlines()
    argument_at = lines.index('[Argument]') + 1
    lines.insert(argument_at, 'f1_wait = input,15,type=number,tag=F1 翻译最长等待秒数,desc=2至15秒；F1 独立等待上限，默认15秒以减少英文回退')
    rewrites = [line for line in lines if line.startswith('^') and ' response-body-json-jq ' in line]
    if len(rewrites) != 1 or not rewrites[0].startswith(r'^https:\/\/uts-api\.itunes\.apple\.com\/uts\/'):
        raise ValueError('expected exactly one static UTS rewrite to replace')
    lines.remove(rewrites[0])
    lines = [line.replace("# The UTS rewrite is embedded using Loon's response-body-json-jq action.",
                          '# One UTS response script routes static subtitles before F1 AI.') for line in lines]
    at = lines.index("[Script]") + 1
    arguments = ',argument={' + TRANSLATION_ARGUMENTS + ',f1_wait},enable=true'
    linear = r'linear-(?:ak|ap|fa)-[a-z0-9-]+\.tv\.apple\.com'
    content = (r'\/Content\/HLS_CBC\/(?:Live\/channel\([^/?#\s)]+\)\/'
               r'|(?:Live|CatchUp)\/Channel\([^/?#\s)]+\)\/Stream\(\d+\)\/)')
    rules = [
        r'http-response ^https:\/\/uts-api\.itunes\.apple\.com\/uts\/(?:v1|v2|v3)\/ '
        + 'script-path=' + script_url + ',requires-body=true,max-size=0,timeout=2,tag=F1.CC.Register' + arguments,
        r'http-response ^https:\/\/hls(?:-amt)?\.itunes\.apple\.com\/itunes-assets\/HLSSportsVodVideo\d+\/v4\/[A-Za-z0-9_./-]+\/P\d+_A\d+_en_subtitles[^/?#]*-\d+\.(?:webvtt|vtt)(?:\?[^\s#]*)?$ '
        + 'script-path=' + script_url + ',requires-body=true,max-size=65536,timeout=18,tag=F1.CC.NativeVTT' + arguments,
        r'http-response ^https:\/\/' + linear + content + r'[^\s?]*\.m3u8(?:\?.*)?$ '
        + 'script-path=' + script_url + ',requires-body=true,max-size=2097152,timeout=2,tag=F1.CC.Media' + arguments,
        r'http-response ^https:\/\/' + linear + content + r'(?:Segment\(\d+\)|[A-Za-z0-9_-]+)\.m4v(?:\?.*)?$ '
        + 'script-path=' + script_url + ',requires-body=true,binary-body-mode=true,max-size=12582912,timeout=2,tag=F1.CC.Observe' + arguments,
        r'http-request ^https:\/\/hls-amt\.itunes\.apple\.com\/__loon_f1_cc\/v1\/(?:[a-f0-9]+\/(?:master|index)\.m3u8|segment\.vtt\?src=[^&]+)$ '
        + 'script-path=' + script_url + ',timeout=22,tag=F1.CC.Subtitles' + arguments,
    ]
    lines[at:at] = rules + ['']
    index = next(i for i, line in enumerate(lines) if line.startswith('hostname = '))
    for host in ('linear-ak-p-har-prod-a.tv.apple.com',
                 'linear-ap-p-har-prod-a.tv.apple.com', 'linear-fa-p-har-prod-a.tv.apple.com',
                 'linear-ap-b-har-prod-a.tv.apple.com',
                 ):
        if host not in lines[index].partition(' = ')[2].split(', '):
            lines[index] += ', ' + host
    hosts = lines[index].partition(' = ')[2].split(', ')
    if set(hosts) & {'play.itunes.apple.com', 'play-edge.itunes.apple.com', 'linear.tv.apple.com'}:
        raise ValueError('shared playback/license hosts must not be intercepted')
    lines[0] = '#!name=Apple TV 中文字幕 + Fitness+ / F1 可选翻译'
    lines[1] = '#!desc=20261129b；按实抓 F1 直播适配 Live/channel 清单和时间戳视频片段；Apple 英文 CC 使用自填 DeepSeek 等服务翻译；保留点播、Fitness+ 及 Music 兼容'
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
