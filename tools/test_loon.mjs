// Exercise pinned playback scripts. Run the embedded rewrite with jq separately.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {pinnedSource} from './upstream_source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = readFileSync(new URL('../build/base/apple-video-subtitles.plugin', import.meta.url), 'utf8');
const upstream = url => {
  const match = /[@/]([a-f0-9]{40})\/(payloads\/.+)$/.exec(url);
  return pinnedSource(match[1], match[2]);
};
const rules = plugin.split('\n').filter(line => line.startsWith('http-')).map(line => {
  const [kind, pattern, ...rest] = line.split(' ');
  return { kind, pattern: new RegExp(pattern), ...Object.fromEntries(rest.join(' ').split(',').map(v => {
    const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)];
  })) };
});
const sources = new Map();
for (const rule of rules) {
  if (!sources.has(rule['script-path'])) {
    const code = upstream(rule['script-path']);
    new vm.Script(code);
    sources.set(rule['script-path'], code);
  }
}
function run(code, globals) {
  const results = [];
  vm.runInNewContext(code, { URL, console, ...globals, $done: value => results.push(value) }, { timeout: 3000 });
  assert.equal(results.length, 1, 'script must finish exactly once');
  return JSON.parse(JSON.stringify(results[0]));
}
const f1 = rules.find(r => r.tag === 'F1.Replay.01-australia.Track.Master.request');
const source = 'https://play.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?id=1337486392&a=1881724926';
const url = 'https://hls-amt.itunes.apple.com/__f1_replay_master/australia/index.m3u8?src=' + encodeURIComponent(source);
assert.ok(f1.pattern.test(url));
const manifest = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",URI="english/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES="subs"\nvideo/index.m3u8\n';
function master(requestUrl, error, status, body) {
  return run(sources.get(f1['script-path']), { $request: { url: requestUrl, headers: {} },
    $httpClient: { get: (_, callback) => callback(error, { status }, body) } });
}
assert.equal(master(url, null, 200, manifest).response.status, 200);
assert.ok(master(url, null, 200, manifest).response.body.includes('LANGUAGE="zh-Hans"'));
assert.equal(master(url.replace('src=', 'bad='), null, 200, manifest).response.status, 400);
assert.equal(master(url, 'timeout', 502, '').response.status, 502);
assert.equal(master(url, null, 200, 'not a manifest').response.status, 502);
const replayRules = rules.filter(r => r.tag.startsWith('F1.Replay.') && r.tag.includes('.Master.'));
for (const masterRule of replayRules) {
  const patternText = masterRule.pattern.source;
  const slugMatch = /__f1_replay_master(?:\\\/|\/)([a-z-]+)/.exec(patternText);
  assert.ok(slugMatch, masterRule.tag);
  const slug = slugMatch[1];
  const playlistUrl = `https://hls-amt.itunes.apple.com/__f1_replay_zh/${slug}/index.m3u8?rev=test&src=test`;
  const vttUrl = `https://hls-amt.itunes.apple.com/__f1_replay_zh/${slug}/seg-001.webvtt?rev=test`;
  assert.ok(rules.some(r => r.pattern.test(playlistUrl)), `missing playlist rule: ${slug}`);
  assert.ok(rules.some(r => r.pattern.test(vttUrl)), `missing VTT rule: ${slug}`);
}
console.log(`Loon checks passed: ${rules.length} request rules, ${sources.size} pinned scripts and ${replayRules.length} F1 replay routes.`);
