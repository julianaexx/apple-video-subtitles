"""Add generic on-demand Fitness+ DeepSeek translation to a Loon plugin."""
import argparse
from pathlib import Path
import re
from urllib.parse import urlsplit


def build(base, script_url):
    url = urlsplit(script_url)
    if url.scheme != "https" or not url.hostname or url.query or url.fragment or url.username or re.search(r'[\s"{},]', script_url):
        raise ValueError("script URL must be a public HTTPS URL")
    if "deepseek_key =" in base:
        raise ValueError("plugin already includes DeepSeek; rebuild from the static base")
    lines = base.splitlines()
    at = next(i for i, line in enumerate(lines) if line.startswith("["))
    lines[at:at] = [
        "[Argument]",
        'deepseek_key = input,"",type=string,tag=DeepSeek API Key,desc=仅在 Loon 本地填写密钥，勿分享含密钥的配置',
        'deepseek_model = input,"deepseek-flash",type=string,tag=DeepSeek 模型,desc=关闭思考模式按需翻译，首次播放可能需要等待',
        'deepseek_wait = input,8,type=number,tag=翻译最长等待秒数,desc=2至15秒，超时立即放行原英文字幕',
        "",
    ]
    at = lines.index("[Script]") + 1
    args = ',argument={deepseek_key,deepseek_model,deepseek_wait},enable=true'
    lines[at:at] = [
        '# Native Fitness+ English captions display Chinese and English in the existing track.',
        r'http-response ^https:\/\/hls-svod\.itunes\.apple\.com\/itunes-assets\/[A-Za-z0-9_./-]*P\d+_A\d+_en_subtitles[^/?#]*-\d+\.(?:webvtt|vtt)(?:\?[^#]*)?$ '
        + 'script-path=' + script_url + ',requires-body=true,max-size=65536,timeout=18,tag=Fitness.DeepSeek.VTT' + args,
        r'http-request ^https:\/\/hls-svod\.itunes\.apple\.com\/__loon_fitness_deepseek\/v1\/(?:index\.m3u8|segment\.vtt)\?src=[^&]+$ '
        + 'script-path=' + script_url + ',timeout=2,tag=Fitness.DeepSeek.LegacyRedirect' + args,
        '',
    ]
    hostname = next(i for i, line in enumerate(lines) if line.startswith('hostname = '))
    for host in ('hls-svod.itunes.apple.com',):
        if host not in lines[hostname].partition(' = ')[2].split(', '):
            lines[hostname] += ', ' + host
    # Reject unsafe custom bases rather than silently retaining Music interception.
    hosts = lines[hostname].partition(' = ')[2].split(', ')
    if 'play.itunes.apple.com' in hosts:
        raise ValueError('Music-safe build must not intercept play.itunes.apple.com')
    lines[0] = '#!name=Apple TV 中文字幕 + Fitness+ DeepSeek'
    lines[1] = '#!desc=20261124a；Fitness+ 选择英文字幕显示中英双语；移除 Music 冲突域名解密；翻译超时放行英文'
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--script-url', required=True)
    args = parser.parse_args()
    try:
        plugin = build(args.base.read_text(encoding='utf-8-sig'), args.script_url)
        args.output.write_bytes(plugin.encode('utf-8'))
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')
