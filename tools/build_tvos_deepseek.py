"""Build the separate Apple TV subscription and the private key setup line."""

import hashlib
from pathlib import Path
import re
from textwrap import indent

from build_deepseek_plugin import build as add_fitness
from build_f1_cc_plugin import build as add_f1
from generate_loon import ROOT, generate

RAW = "https://raw.githubusercontent.com/julianaexx/apple-video-subtitles/main"
# The Apple TV subscription is independent of changes to the iOS subscription.
F1_SOURCE = "f1-cc-deepseek-40ce902d4016e848f3c95f934b3054fde56f3cd648e5617d06e77f853c4863ee.js"
FITNESS_SOURCE = "fitness-deepseek-0868308dce63fd05d2d7c751a8c7e9e862624acc8fd504c3b903585e8ac1df5a.js"
SETUP_PATTERN = (
    r"^https:\/\/(?:uts-api\.itunes\.apple\.com\/uts\/|"
    r"hls-svod\.itunes\.apple\.com\/itunes-assets\/[^?#]*_en_subtitles)"
)
SPORTS_CAPTION = (
    r"^https:\/\/hls(?:-amt|-svod)?\.itunes\.apple\.com\/itunes-assets\/"
    r"HLSSportsVodVideo\d+\/v4\/[A-Za-z0-9_./-]+\/"
    r"P(\d+)_A(\d+)_en_subtitles[^/?#]*-\d+\.(?:webvtt|vtt)(?:\?[^\s#]*)?$"
)


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Unexpected Apple TV source: {old}")
    return text.replace(old, new, 1)


def tvos_runtime():
    f1 = (ROOT / "scripts" / F1_SOURCE).read_text(encoding="utf-8")
    fitness = (ROOT / "scripts" / FITNESS_SOURCE).read_text(encoding="utf-8")
    # Both released scripts begin with the same DeepSeek adapter.
    marker = "const APPLE_STATIC_CATALOG = "
    adapter, f1 = f1.split(marker, 1)
    if not fitness.startswith(adapter):
        raise ValueError("F1 and Fitness+ do not have the same translation adapter")
    fitness = fitness[len(adapter):]
    f1 = marker + f1
    f1 = replace_once(f1, "function appleStaticPlayback(value) {",
                      "function appleStaticPlayback(value, registerReplay) {")
    f1 = replace_once(f1, "    return bridge('/__f1_replay_master/' + replay.slug + '/index.m3u8', replay.revision);",
                      "    registerReplay(value);\n    return value;")
    f1 = replace_once(f1, "const target=appleStaticPlayback(node[key]);",
                      "const target=appleStaticPlayback(node[key], registerVOD);")
    f1 = replace_once(
        f1,
        r"const match=/^https:\/\/hls(?:-amt)?\.itunes\.apple\.com\/itunes-assets\/HLSSportsVodVideo\d+\/v4\/[A-Za-z0-9_./-]+\/P(\d+)_A(\d+)_en_subtitles[^/?#]*-\d+\.(?:webvtt|vtt)(?:\?[^\s#]*)?$/.exec(source);",
        "const match=APPLE_TV_SPORTS_CAPTION.exec(source);",
    )
    f1 = replace_once(f1, "const record=read('vod-'+hash(match[1]+':'+match[2]));",
                      """const [, program, asset] = match;
    if (APPLE_STATIC_CATALOG.replays.some(row => row.programId === program && row.assetId === asset)) return true;
    // Verified Las Vegas Race in 30 asset, which can play from a cached page.
    if (program === '1560312730' && asset === '6837919154') return true;
    const record=read('vod-'+hash(program+':'+asset));""")
    f1 = replace_once(f1, "if(!service.ready||!masterSource(source))return false;",
                      "if(!/^https:\\/\\/play(?:-edge)?(?:-cdn)?\\.itunes\\.apple\\.com\\//.test(source)"
                      "||!masterSource(source))return false;")
    f1 = f1.replace(r"play(?:-edge)?\.itunes", r"play(?:-edge)?(?:-cdn)?\.itunes")
    f1 = replace_once(f1, "const f1=inherited||meta.leagueShortName==='F1'||meta.leagueName==='Formula 1';",
                      """const f1 = inherited || [node, meta].some(item =>
        [item.leagueShortName, item.leagueName, item.league?.shortName, item.league?.name]
          .some(name => typeof name === 'string' && /^(?:F1|Formula\\s*1)$/i.test(name.trim()))
      );""")
    f1 = replace_once(f1, "if(f1&&node.assets&&typeof node.assets.hlsUrl==='string'&&node.airingType==='OnDemand'){",
                      """if (f1 && typeof node.hlsUrl === 'string') registerVOD(node.hlsUrl);
      if (f1 && node.assets && typeof node.assets.hlsUrl === 'string') {
        registerVOD(node.assets.hlsUrl);
      }
      if(f1&&node.assets&&typeof node.assets.hlsUrl==='string'&&node.airingType==='OnDemand'){""")
    f1 = replace_once(
        f1,
        "          // Register the asset, without changing Apple's signed playback URL.\n"
        "          // Only its observed native English WebVTT responses may be translated.\n"
        "          registerVOD(source);\n",
        "",
    )
    entry = (ROOT / "tools/tvos_deepseek_entry.js").read_text(encoding="utf-8")
    return (
        "(function (configArgument) {\n"
        + indent(entry, "  ")
        + "  const args = tvOSDeepSeekArguments(configArgument);\n"
          "  if (!args) return;\n"
          "  (function ($argument) {\n"
        + indent(adapter, "    ")
        + f"    const APPLE_TV_SPORTS_CAPTION = /{SPORTS_CAPTION}/;\n"
        + "    if (/^https:\\/\\/hls-svod\\.itunes\\.apple\\.com\\//.test($request.url)\n"
          "        && !APPLE_TV_SPORTS_CAPTION.test($request.url)) {\n"
        + indent(fitness, "      ")
        + "      return;\n"
          "    }\n"
        + indent(f1, "    ")
        + "  })(args);\n"
          "})(typeof $argument === 'undefined' ? undefined : $argument);\n"
    )


def build_files():
    runtime = tvos_runtime()
    digest = hashlib.sha256(runtime.encode("utf-8")).hexdigest()
    filename = f"apple-tv-deepseek-{digest}.js"
    script_url = f"{RAW}/scripts/{filename}"
    setup = (
        f'http-request {SETUP_PATTERN} script-path={script_url},'
        'timeout=2,tag=AppleTV.DeepSeek.Key,argument="PASTE_DEEPSEEK_KEY_HERE",enable=true'
    )
    generated, _ = generate()
    base = generated["apple-video-subtitles.plugin"]
    lines = add_f1(add_fitness(base, script_url), script_url).splitlines()
    lines[:2] = [
        "#!name=Apple TV 中文字幕（DeepSeek）",
        "#!desc=Apple TV 正赛使用原始播放地址。补齐 F1 字幕域名和回放识别。中文出现在英文轨。",
    ]
    start = lines.index("[Argument]")
    end = lines.index("[Rewrite]")
    lines[start:end] = ["# DeepSeek setup: " + RAW + "/loon/apple-tv-deepseek-setup.txt", ""]
    lines = [re.sub(r",argument=\{[^}]+\}", "", line) for line in lines]
    hosts = next(index for index, line in enumerate(lines) if line.startswith("hostname = "))
    if "hls.itunes.apple.com" not in lines[hosts].partition(" = ")[2].split(", "):
        lines[hosts] += ", hls.itunes.apple.com"
    return {
        "loon/apple-tv-deepseek.plugin": "\n".join(lines) + "\n",
        "loon/apple-tv-deepseek-setup.txt": setup + "\n",
        f"scripts/{filename}": runtime,
    }


if __name__ == "__main__":
    for name, contents in build_files().items():
        path = ROOT / name
        path.write_bytes(contents.encode("utf-8"))
        print(name)
