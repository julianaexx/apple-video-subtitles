import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const plugin = readFileSync(process.argv[2] ?? new URL('../loon/apple-tv-deepseek.plugin', import.meta.url), 'utf8');
const rules = plugin.split(/\r?\n/).filter(line => line.startsWith('http-response ')).map(line => {
  const [, pattern, options] = line.split(' ', 3);
  const { groups } = /script-path=(?<script>[^,]+).*?,tag=(?<tag>[^,]+)/.exec(options);
  return { pattern: new RegExp(pattern), ...groups };
});
const mitmHosts = plugin.match(/^hostname = (.+)$/m)[1].split(', ');
const sportsRule = rules.find(({ tag }) => tag === 'F1.CC.NativeVTT');
const raceRule = rules.find(({ tag }) => tag === 'F1.CC.RaceVTT');
const masterRule = rules.find(({ tag }) => tag === 'F1.RaceTrack.Master');
const sidecarRule = new RegExp(plugin.split(/\r?\n/).find(
  line => line.includes(',tag=F1.RaceTrack.Subtitle,'),
).split(' ')[1]);
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
function run(url, body, expectedTag, playlist) {
  assert.ok(mitmHosts.includes(new URL(url).hostname));
  if (body === undefined) assert.ok(sidecarRule.test(url));
  else {
    const matched = rules.filter(({ pattern }) => pattern.test(url));
    assert.deepEqual(matched.map(({ tag }) => tag), [expectedTag]);
    assert.equal(matched[0].script, sportsRule.script);
  }
  const results = [];
  script.runInNewContext({
    $request: { url, headers: {} },
    ...(body === undefined ? {} : { $response: { status: 200, body } }),
    $argument: { deepseek_key: 'sk-local-fixture' },
    $persistentStore: { read: key => store.get(key), write(value, key) { store.set(key, value); return true; } },
    $httpClient: {
      get({ url }, callback) {
        if (playlist?.url === url) {
          callback(null, { status: 200 }, playlist.body);
          return;
        }
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
  return results[0].response || results[0].body;
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
  'F1.CC.Register'), undefined, 'Apple keeps the signed playback URL');
assert.equal(run(sports('hls-svod', 1001, 2001), vtt, 'F1.CC.NativeVTT'), expected);

const workout = 'https://hls-svod.itunes.apple.com/itunes-assets/HLSVideo126/v4/workout/P1_A2_en_subtitles_V2-0.webvtt';
assert.equal(run(workout, vtt, 'Fitness.DeepSeek.VTT'), expected);
assert.equal(apiCalls, 4, 'Fitness+ retains its own translation path and cache');

assert.ok(!masterRule.pattern.test(source), 'unknown assets cannot receive a Chinese track');
assert.ok(!masterRule.pattern.test(source.replace('subscription/playlist', 'subscription/key')));
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

  const appleMaster = source.replace('id=1001&a=2001', 'a=' + asset + '&id=' + program);
  const donor = 'https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/stream/playlist.m3u8'
    + '?p=' + program + '&a=' + asset + '&mainAssetAdamId=' + asset;
  const originalMaster = '#EXTM3U\r\n#EXT-X-INDEPENDENT-SEGMENTS\r\n'
    + '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",URI="' + donor + '"\r\n'
    + '#EXT-X-STREAM-INF:SUBTITLES="subs"\r\noriginal-video.m3u8\r\n';
  const newMaster = run(appleMaster, originalMaster, 'F1.RaceTrack.Master');
  assert.ok(newMaster.includes('NAME="简体中文",LANGUAGE="zh-Hans"'));
  assert.equal(newMaster.split('\r\n').filter(line => !line.includes('LANGUAGE="zh-Hans"')).join('\r\n'), originalMaster);
  assert.equal(run(appleMaster, newMaster, 'F1.RaceTrack.Master'), undefined, 'no duplicate Chinese track');
  const sidecar = /URI="(https:\/\/[^"]+\/__loon_race_zh\/[^"]+)"/.exec(newMaster)[1];
  const segmentBase = alternate.replace('V2-99.webvtt', 'V2-');
  const nativeSegments = Array.from({ length: raceCatalog[program + ':' + asset].segments },
    (_, index) => '#EXTINF:60,\n' + segmentBase + index + '.webvtt').join('\n');
  const playlistBody = '#EXTM3U\n#EXT-X-VERSION:5\n' + nativeSegments + '\n#EXT-X-ENDLIST\n';
  const chinesePlaylist = run(sidecar, undefined, null, { url: donor, body: playlistBody });
  assert.equal(chinesePlaylist.status, 200);
  const hundredth = chinesePlaylist.body.split('\n').find(line => line.endsWith('/seg-100.webvtt'));
  assert.equal(run(hundredth).body, preset);
  const mismatch = run(sidecar, undefined, null, { url: donor, body: '#EXTM3U\n' });
  assert.equal(mismatch.status, 302);
  assert.equal(mismatch.headers.Location, donor);
}
console.log('Apple TV race tracks, native caption fallbacks, and Fitness+ translation passed.');
