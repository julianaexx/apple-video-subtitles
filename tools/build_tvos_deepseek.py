"""Build the separate Apple TV subscription and the private key setup line."""

import hashlib
import json
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
    r"(?:hls(?:-amt|-svod)?\.itunes\.apple\.com\/itunes-assets\/|"
    r"vod-(?:ap|ak|fa)-amt\.tv\.apple\.com\/)[^?#]*_en_subtitles)"
)
SPORTS_ASSET_DIRECTORY = r"HLSSportsVodVideo\d+\/"
HLS_HOST = r"hls(?:-amt|-svod)?\.itunes\.apple\.com"
CAPTION_FILENAME = (
    r"P(\d+)_A(\d+)_(en_subtitles[^/?#]*)-(\d+)\.(?:webvtt|vtt)(?:\?[^\s#]*)?$"
)
SPORTS_CAPTION = (
    r"^https:\/\/" + HLS_HOST + r"\/itunes-assets\/"
    + SPORTS_ASSET_DIRECTORY
    + r"v4\/[A-Za-z0-9_./-]+\/"
    + CAPTION_FILENAME
)
LEGACY_REPLAY = r"^https:\/\/hls-amt\.itunes\.apple\.com\/__f1_replay_master\/[a-z-]+\/index\.m3u8(?:\?([^#\s]+))?$"


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Unexpected Apple TV source: {old}")
    return text.replace(old, new, 1)


def race_captions(base):
    rules = base.splitlines()
    playlist = next(line.split("script-path=", 1)[1].split(",", 1)[0] for line in rules
                    if ",tag=F1.Replay.19-mexico.Track.Playlist.request," in line)
    mirror = RAW + "/vendor/pinned/"
    if not playlist.startswith(mirror):
        raise ValueError("Unrecognized race playlist source")
    data = (ROOT / "vendor/pinned" / playlist[len(mirror):]).read_text(encoding="utf-8")
    configs = json.loads(re.search(r"^const replayConfigs = (.+);$", data, re.M)[1])
    catalog = {}
    for line in rules:
        match = re.search(r"script-path=(https://[^,]+).*?,tag=F1\.Replay\.\d+-([a-z-]+)\.Track\.VTT\.request,",
                          line, re.I)
        if not match:
            continue
        url, slug = match.groups()
        if not url.startswith(mirror) or slug not in configs:
            raise ValueError(f"Missing pinned subtitle mapping for {slug}")
        config = configs[slug]
        tracks = config.get("subtitleTracks", {})
        for program in config.get("programIds", [config["programId"]]):
            catalog[f"{program}:{config['assetId']}"] = {
                "track": tracks.get(program, r"en_subtitles_V\d+"),
                "segments": config["expectedSegments"],
                "revision": url[len(mirror):].split("/", 1)[0],
                "url": url,
            }
    if not catalog:
        raise ValueError("Missing pinned race captions")
    return catalog


def race_pairs(catalog):
    return "|".join("P" + item.replace(":", "_A") for item in catalog)


def race_caption_pattern(pairs):
    # The HLS branch excludes requests already handled by the sports rule.
    host = (rf"(?:{HLS_HOST}\/itunes-assets\/(?!{SPORTS_ASSET_DIRECTORY}v4\/)"
            r"|vod-(?:ap|ak|fa)-amt\.tv\.apple\.com\/)")
    return (r"^https:\/\/" + host + r"(?:[A-Za-z0-9_./-]+\/)?"
            + f"(?=(?:{pairs})_)" + CAPTION_FILENAME)


def caption_routes(lines, alternate, pairs):
    f1_rule, = (i for i, line in enumerate(lines) if ",tag=F1.CC.NativeVTT," in line)
    _, _, options = lines[f1_rule].split(" ", 2)
    lines[f1_rule] = f"http-response {SPORTS_CAPTION} {options}"

    fitness_rule, = (i for i, line in enumerate(lines) if ",tag=Fitness.DeepSeek.VTT," in line)
    asset_path = r"\/itunes-assets\/"
    excluded_assets = rf"(?!{SPORTS_ASSET_DIRECTORY}|(?:[A-Za-z0-9_./-]+\/)?(?:{pairs})_en_subtitles)"
    lines[fitness_rule] = replace_once(
        lines[fitness_rule], asset_path, asset_path + excluded_assets
    )
    options = options.replace(",tag=F1.CC.NativeVTT,", ",tag=F1.CC.RaceVTT,")
    lines.insert(f1_rule + 1, f"http-response {alternate} {options}")


def replay_bridge_files(lines):
    files = {}
    prefix = RAW + "/vendor/pinned/"
    support = (ROOT / "tools/tvos_replay_bridge.js").read_text(encoding="utf-8")
    for tag, inject in (("Master", "injectTrack"), ("Playlist", "injectPlaylist")):
        indexes = [i for i, line in enumerate(lines)
                   if ",tag=F1.Replay." in line and f".Track.{tag}.request," in line]
        urls = {re.search(r"script-path=(https://[^,]+)", lines[i])[1] for i in indexes}
        source_url, = urls
        if not source_url.startswith(prefix):
            raise ValueError("Unexpected iOS replay script")
        source = (ROOT / "vendor/pinned" / source_url[len(prefix):]).read_text(encoding="utf-8")
        # Reuse the exact iOS HLS edits and substitute the tvOS request wrapper.
        source = source.split("\nfunction fail(status, body) {", 1)[0]
        source = source.replace("new URL(", "new ReplayURL(")
        source = source.replace(r"play(?:-edge)?\.itunes", r"play(?:-edge)?(?:-cdn)?\.itunes")
        script = support + "\n" + source + f"\nrunReplayBridge({inject});\n"
        digest = hashlib.sha256(script.encode("utf-8")).hexdigest()
        path = f"scripts/apple-tv-replay-{tag.lower()}-{digest}.js"
        files[path] = script
        for i in indexes:
            lines[i] = lines[i].replace(source_url, RAW + "/" + path).replace(",timeout=30,", ",timeout=6,")
    return files


def tvos_runtime(catalog, alternate, *, native_replays=False):
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
    replay_route = "    return value;" if native_replays else (
        "    const key = replay.programId + ':' + replay.assetId;\n"
        "    return APPLE_TV_RACE_CAPTIONS[key]\n"
        "      ? bridge('/__f1_replay_master/' + replay.slug + '/index.m3u8', replay.revision, value)\n"
        "      : value;"
    )
    f1 = replace_once(f1, "    return bridge('/__f1_replay_master/' + replay.slug + '/index.m3u8', replay.revision);",
                      "    registerReplay(value);\n" + replay_route)
    f1 = replace_once(f1, "const target=appleStaticPlayback(node[key]);",
                      "const target=appleStaticPlayback(node[key], registerVOD);")
    f1 = replace_once(
        f1,
        r"const match=/^https:\/\/hls(?:-amt)?\.itunes\.apple\.com\/itunes-assets\/HLSSportsVodVideo\d+\/v4\/[A-Za-z0-9_./-]+\/P(\d+)_A(\d+)_en_subtitles[^/?#]*-\d+\.(?:webvtt|vtt)(?:\?[^\s#]*)?$/.exec(source);",
        "const match=APPLE_TV_SPORTS_CAPTION.exec(source) || APPLE_TV_RACE_CAPTION.exec(source);",
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
    f1 = replace_once(
        f1,
        "if(nativeVTT(source)){log('F1 点播原生英文字幕');translate({body,native:true});return;}",
        """if (nativeVTT(source)) {
        const match = APPLE_TV_SPORTS_CAPTION.exec(source) || APPLE_TV_RACE_CAPTION.exec(source);
        tvOSRaceCaption(match, body, finish, () => translate({body,native:true}));
        return;
      }""",
    )
    legacy = ""
    if native_replays:
        legacy = (f"const APPLE_TV_LEGACY_REPLAY = /{LEGACY_REPLAY}/;\n"
                  + (ROOT / "tools/tvos_native_replay.js").read_text(encoding="utf-8"))
        f1 = replace_once(f1, "if (typeof value !== 'string') return value;",
                          "if (typeof value !== 'string') return value;\n"
                          "  const originalReplay = tvOSOriginalReplay(value);\n"
                          "  if (originalReplay) {\n"
                          "    registerReplay(originalReplay);\n"
                          "    return originalReplay;\n"
                          "  }")
        f1 = replace_once(f1, "    const main=/^https:",
                          "    if (APPLE_TV_LEGACY_REPLAY.test(source)) {\n"
                          "      const original = tvOSOriginalReplay(source);\n"
                          "      if (original) finish({url:original});\n"
                          "      else send('Reload this race in Apple TV', 'text/plain', 400);\n"
                          "      return;\n"
                          "    }\n"
                          "    const main=/^https:")
        f1 = replace_once(f1, "const VERSION='f1cc-20261125a'", "const VERSION='tvos-native-20261126b'")
        f1 = replace_once(f1, "if (APPLE_STATIC_CATALOG.replays.some(row => row.programId === program && row.assetId === asset)) return true;",
                          "if (APPLE_TV_RACE_CAPTIONS[program + ':' + asset]) return true;")
    entry = (ROOT / "tools/tvos_deepseek_entry.js").read_text(encoding="utf-8")
    return (
        "(function (configArgument) {\n"
        + indent(entry, "  ")
        + "  const args = tvOSDeepSeekArguments(configArgument);\n"
          "  if (!args) return;\n"
          "  (function ($argument) {\n"
        + indent(adapter, "    ")
        + f"    const APPLE_TV_SPORTS_CAPTION = /{SPORTS_CAPTION}/;\n"
        + f"    const APPLE_TV_RACE_CAPTION = /{alternate}/;\n"
        + "    const APPLE_TV_RACE_CAPTIONS = " + json.dumps(catalog, separators=(",", ":")) + ";\n"
        + (indent(legacy, "    ") + "\n" if legacy else "")
        + indent((ROOT / "tools/tvos_race_captions.js").read_text(encoding="utf-8"), "    ") + "\n"
        + "    if (/^https:\\/\\/hls-svod\\.itunes\\.apple\\.com\\//.test($request.url)\n"
          "        && !APPLE_TV_SPORTS_CAPTION.test($request.url)\n"
          "        && !APPLE_TV_RACE_CAPTION.test($request.url)) {\n"
        + indent(fitness, "      ")
        + "      return;\n"
          "    }\n"
        + indent(f1, "    ")
        + "  })(args);\n"
          "})(typeof $argument === 'undefined' ? undefined : $argument);\n"
    )


def build_files():
    generated, _ = generate()
    base = generated["apple-video-subtitles.plugin"]
    catalog = race_captions(base)
    pairs = race_pairs(catalog)
    alternate = race_caption_pattern(pairs)
    runtime = tvos_runtime(catalog, alternate)
    digest = hashlib.sha256(runtime.encode("utf-8")).hexdigest()
    filename = f"apple-tv-deepseek-{digest}.js"
    script_url = f"{RAW}/scripts/{filename}"
    setup = (
        f'http-request {SETUP_PATTERN} script-path={RAW}/scripts/apple-tv-deepseek-key.js,'
        'timeout=2,tag=AppleTV.DeepSeek.Key,argument="PASTE_DEEPSEEK_KEY_HERE",enable=true'
    )
    lines = add_f1(add_fitness(base, script_url), script_url).splitlines()
    caption_routes(lines, alternate, pairs)
    bridges = replay_bridge_files(lines)
    lines[:2] = [
        "#!name=Apple TV 中文字幕（DeepSeek）",
        "#!desc=正赛沿用 iPhone 版预制字幕轨。添加字幕失败时回到原播放地址。",
    ]
    start = lines.index("[Argument]")
    end = lines.index("[Rewrite]")
    lines[start:end] = ["# DeepSeek setup: " + RAW + "/loon/apple-tv-deepseek-setup.txt", ""]
    lines = [re.sub(r",argument=\{[^}]+\}", "", line) for line in lines]
    hosts = next(index for index, line in enumerate(lines) if line.startswith("hostname = "))
    if "hls.itunes.apple.com" not in lines[hosts].partition(" = ")[2].split(", "):
        lines[hosts] += ", hls.itunes.apple.com"
    native_runtime = tvos_runtime(catalog, alternate, native_replays=True)
    native_digest = hashlib.sha256(native_runtime.encode("utf-8")).hexdigest()
    native_filename = f"apple-tv-deepseek-{native_digest}.js"
    native_url = f"{RAW}/scripts/{native_filename}"
    native_lines = [
        line.replace(script_url + ",", native_url + ",argument={deepseek_key},")
        for line in lines if ",tag=F1.Replay." not in line or ".Track.Master.request," not in line
    ]
    native_lines[:3] = [
        "#!name=Apple TV 中文字幕（原生播放 20261127）",
        "#!desc=正赛使用 Apple 原始播放地址。选择英文字幕轨可显示中文。",
        "# Generated by tools/build_tvos_deepseek.py. Do not edit.",
    ]
    setup_comment = next(i for i, line in enumerate(native_lines) if line.startswith("# DeepSeek setup:"))
    native_lines[setup_comment:setup_comment + 1] = [
        "[Argument]",
        'deepseek_key = input,"",type=string,tag=DeepSeek API Key',
    ]
    native_lines.insert(native_lines.index("[Script]") + 1,
                        f"http-request {LEGACY_REPLAY} script-path={native_url},"
                        "timeout=2,tag=AppleTV.LegacyReplay,enable=true")
    return {
        "loon/apple-tv-deepseek.plugin": "\n".join(lines) + "\n",
        "loon/apple-tv-deepseek-ready.plugin": "\n".join(native_lines) + "\n",
        "loon/apple-tv-deepseek-setup.txt": setup + "\n",
        f"scripts/{filename}": runtime,
        f"scripts/{native_filename}": native_runtime,
        **bridges,
    }


if __name__ == "__main__":
    for name, contents in build_files().items():
        path = ROOT / name
        path.write_bytes(contents.encode("utf-8"))
        print(name)
