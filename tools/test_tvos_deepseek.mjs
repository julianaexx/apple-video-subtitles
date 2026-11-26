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
const runtime = readFileSync(new URL('../scripts/' + sportsRule.script.split('/').at(-1), import.meta.url), 'utf8');
const script = new vm.Script(runtime);
assert.equal(runtime.match(/APPLE_TV_SPORTS_CAPTION = \/(.+)\/;/)[1], sportsRule.pattern.source);

const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWelcome back.\n';
const source = 'https://play-edge-cdn.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?id=1001&a=2001&t=fixture';
const uts = 'https://uts-api.itunes.apple.com/uts/v3/sporting-events/f1';
const store = new Map();
let apiCalls = 0;
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
  'F1.CC.Register'), undefined, 'Apple keeps the signed playback URL');
assert.equal(run(sports('hls-svod', 1001, 2001), vtt, 'F1.CC.NativeVTT'), expected);

const workout = 'https://hls-svod.itunes.apple.com/itunes-assets/HLSVideo126/v4/workout/P1_A2_en_subtitles_V2-0.webvtt';
assert.equal(run(workout, vtt, 'Fitness.DeepSeek.VTT'), expected);
assert.equal(apiCalls, 4, 'Fitness+ retains its own translation path and cache');
console.log('Apple TV F1 host routing, native playback, and Fitness+ translation passed.');
