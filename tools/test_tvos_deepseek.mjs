import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const plugin = readFileSync(process.argv[2] ?? new URL('../loon/apple-tv-deepseek.plugin', import.meta.url), 'utf8');
const rules = plugin.split(/\r?\n/).filter(line => line.startsWith('http-response ')).map(line => {
  const [, pattern, options] = line.split(' ', 3);
  const { groups } = /script-path=(?<script>[^,]+).*?,tag=(?<tag>[^,]+)/.exec(options);
  return { pattern: new RegExp(pattern), ...groups };
});
const requestRules = plugin.split(/\r?\n/).filter(line => line.startsWith('http-request ')).map(line => {
  const [, pattern, options] = line.split(' ', 3);
  const { groups } = /script-path=(?<script>[^,]+).*?,tag=(?<tag>[^,]+)/.exec(options);
  return { pattern: new RegExp(pattern), ...groups };
});
const mitmHosts = plugin.match(/^hostname = (.+)$/m)[1].split(', ');
assert.ok(!mitmHosts.some(host => /^play(?:-edge)?(?:-cdn)?\.itunes\.apple\.com$/.test(host)));
const sportsRule = rules.find(({ tag }) => tag === 'F1.CC.NativeVTT');
const raceRule = rules.find(({ tag }) => tag === 'F1.CC.RaceVTT');
const runtime = readFileSync(new URL('../scripts/' + sportsRule.script.split('/').at(-1), import.meta.url), 'utf8');
const script = new vm.Script(runtime);
assert.equal(runtime.match(/APPLE_TV_SPORTS_CAPTION = \/(.+)\/;/)[1], sportsRule.pattern.source);
assert.equal(runtime.match(/APPLE_TV_RACE_CAPTION = \/(.+)\/;/)[1], raceRule.pattern.source);
const raceCatalog = JSON.parse(runtime.match(/^\s*const APPLE_TV_RACE_CAPTIONS = (.+);$/m)[1]);

const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWelcome back.\n';
const source = 'https://play-edge-cdn.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?id=1001&a=2001&t=fixture';
const uts = 'https://uts-api.itunes.apple.com/uts/v3/sporting-events/f1';
const store = new Map();
let apiCalls = 0;
let captionDownloads = 0;
function run(url, body, expectedTag) {
  assert.ok(mitmHosts.includes(new URL(url).hostname));
  const matched = rules.filter(({ pattern }) => pattern.test(url));
  assert.deepEqual(matched.map(({ tag }) => tag), [expectedTag]);
  assert.equal(matched[0].script, sportsRule.script);
  const results = [];
  script.runInNewContext({
    $request: { url, headers: {} },
    $response: { status: 200, body },
    $argument: { deepseek_key: 'sk-local-fixture' },
    $persistentStore: { read: key => store.get(key), write(value, key) { store.set(key, value); return true; } },
    $httpClient: {
      get({ url }, callback) {
        assert.ok(Object.values(raceCatalog).some(replay => replay.url === url));
        captionDownloads++;
        const path = url.split('/main/')[1];
        callback(null, { status: 200 }, readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
      },
      post(options, callback) {
        assert.equal(options.url, 'https://api.deepseek.com/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer sk-local-fixture');
        apiCalls++;
        callback(null, { status: 200 }, JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"translations":["欢迎回来。"]}' } }],
        }));
      },
    },
    console: { log() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    $done: result => results.push(result),
  }, { timeout: 1000 });
  assert.equal(results.length, 1);
  return results[0].body;
}

function sports(host, program, asset) {
  return 'https://' + host + '.itunes.apple.com/itunes-assets/HLSSportsVodVideo211/v4/sample/' +
    'P' + program + '_A' + asset + '_en_subtitles_V2-0.webvtt?fixture=1';
}

const expected = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n欢迎回来。\n\n';
for (const [host, program, asset] of [
  ['hls', 1543396071, 1882105309],
  ['hls-amt', 1536601273, 1881678292],
  ['hls-svod', 1560312730, 6837919154],
]) {
  store.clear();
  assert.equal(run(sports(host, program, asset), vtt, 'F1.CC.NativeVTT'), expected);
}
assert.equal(run(sports('hls-svod', 1001, 2001), vtt, 'F1.CC.NativeVTT'), undefined);
assert.equal(apiCalls, 3, 'unregistered sports assets cannot call DeepSeek');
assert.equal(run(uts, JSON.stringify({ league: { name: 'Formula 1' }, items: [{ hlsUrl: source }] }),
  'F1.CC.Register'), undefined, 'qualifying and practice retain their native playback URL');
assert.equal(run(sports('hls-svod', 1001, 2001), vtt, 'F1.CC.NativeVTT'), expected);

const workout = 'https://hls-svod.itunes.apple.com/itunes-assets/HLSVideo126/v4/workout/P1_A2_en_subtitles_V2-0.webvtt';
assert.equal(run(workout, vtt, 'Fitness.DeepSeek.VTT'), expected);
assert.equal(apiCalls, 4, 'Fitness+ retains its own translation path and cache');

for (const [program, asset] of [[1543396071, 1882105309], [1536601273, 1881678292]]) {
  store.clear();
  const { url } = raceCatalog[program + ':' + asset];
  const assetCode = readFileSync(new URL('../' + url.split('/main/')[1], import.meta.url), 'utf8');
  const preset = JSON.parse(assetCode.match(/^const subtitles = (.+);$/m)[1])['100'];
  const timing = preset.match(/^\d+:[\d:.]+ --> [^\r\n]+/gm);
  const english = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n'
    + timing.map(line => line + '\nOriginal English.').join('\n\n') + '\n\n';
  const segment = 'P' + program + '_A' + asset + '_en_subtitles_V2-99.webvtt';
  const alternate = 'https://vod-ap-amt.tv.apple.com/alternate/path/' + segment;
  const legacyHls = 'https://hls-svod.itunes.apple.com/itunes-assets/legacy/path/' + segment;
  const before = captionDownloads;
  assert.equal(run(alternate, english, 'F1.CC.RaceVTT'), preset);
  assert.equal(run(legacyHls, english, 'F1.CC.RaceVTT'), preset);
  assert.equal(run(sports('hls', program, asset).replace('V2-0.', 'V2-99.'), english, 'F1.CC.NativeVTT'), preset);
  assert.equal(captionDownloads - before, 1, 'matching segments reuse the pinned translation');
  const wrongMap = english.replace('MPEGTS:900000', 'MPEGTS:900001');
  assert.notEqual(run(alternate, wrongMap, 'F1.CC.RaceVTT'), preset);

  const raceMaster = source.replace('id=1001&a=2001', 'id=' + program + '&a=' + asset);
  const configured = JSON.parse(run(uts, JSON.stringify({assets:{hlsUrl:raceMaster}}), 'F1.CC.Register'));
  const bridge = configured.assets.hlsUrl;
  assert.equal(new URL(bridge).searchParams.get('src'), raceMaster);
  const donor = 'https://play-edge-cdn.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/stream/playlist.m3u8'
    + '?p=' + program + '&a=' + asset + '&mainAssetAdamId=' + asset + '&cdn=vod-ap-aoc.tv.apple.com';
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",URI="' + donor + '"\n'
    + '#EXT-X-STREAM-INF:SUBTITLES="subs"\n../video/index.m3u8\n';
  function replayRequest(url, expected, target, reply, useURL = false) {
    const matched = requestRules.filter(row => row.pattern.test(url));
    assert.equal(matched.length, 1);
    assert.ok(matched[0].tag.endsWith(expected + '.request'));
    const relative = matched[0].script.split('/main/')[1];
    const code = readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
    const results = [];
    let deadline;
    vm.runInNewContext(code, {
      ...(useURL ? {URL} : {}),
      $request:{url,headers:{}},
      $httpClient:{get(options, callback) {
        assert.equal(options.url, target);
        if (reply !== null) callback(null, {status:200}, reply);
      }},
      $done: result => results.push(result),
      setTimeout(callback) { deadline = callback; return 1; },
      clearTimeout() {},
    }, {timeout:1000});
    if (!results.length && deadline) deadline();
    assert.equal(results.length, 1);
    return results[0].response;
  }
  const added = replayRequest(bridge, 'Master', raceMaster, master);
  assert.equal(added.status, 200);
  assert.ok(added.body.includes('NAME="简体中文"'));
  assert.ok(added.body.includes('https://play-edge-cdn.itunes.apple.com/'));
  const chinese = added.body.split('\n').find(line => line.includes('LANGUAGE="zh-Hans"')).match(/URI="([^"]+)"/)[1];
  const segmentBase = alternate.replace('V2-99.webvtt', 'V2-');
  const playlist = '#EXTM3U\n' + Array.from({length:raceCatalog[program + ':' + asset].segments},
    (_, index) => '#EXTINF:60,\n' + segmentBase + index + '.webvtt').join('\n') + '\n#EXT-X-ENDLIST\n';
  const sidecar = replayRequest(chinese, 'Playlist', donor, playlist);
  assert.equal(sidecar.status, 200);
  const hundredth = sidecar.body.split('\n').find(line => line.endsWith('/seg-100.webvtt'));
  assert.equal(replayRequest(hundredth, 'Vtt', undefined, undefined, true).body, preset);
  for (const bad of ['#EXTM3U\n', null]) {
    const fallback = replayRequest(bridge, 'Master', raceMaster, bad);
    assert.equal(fallback.status, 302);
    assert.equal(fallback.headers.Location, raceMaster);
  }
  assert.equal(replayRequest(chinese, 'Playlist', donor, '#EXTM3U\n').headers.Location, donor);
}
console.log('Apple TV iPhone-path race tracks, fallback, and Fitness+ translation passed.');
