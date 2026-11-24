// Set APPLE_SUBTITLES_JQ to a jq executable, then run: node tools/test_loon_jq.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pinnedSource } from './upstream_source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = fs.readFileSync(path.join(root, 'build/base/apple-video-subtitles.plugin'), 'utf8');
const program = /response-body-json-jq '([^\n]*)'$/m.exec(plugin)[1];
const source = pinnedSource('35b5421e5efa54ff5d0617bcebec57eed325158a',
  'payloads/surge/series/2019-formula-1-drive-to-survive/season-08/uts-redirect.js');
const catalog = name => JSON.parse(new RegExp('^const ' + name + ' = (.+);$', 'm').exec(source)[1]);
const play = 'https://play.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?';
const urls = [
  ...Object.keys(catalog('targets')).map(key => play + 'a=' + key),
  ...Object.keys(catalog('seriesTargets')).map(key => play.replace('play.itunes', 'play-edge-cdn.itunes') + 'a=' + key),
  ...catalog('f1Replays').map(r => play + 'id=' + r.programId + '&a=' + r.assetId),
  ...catalog('replayConfigs').map(r => 'https://linear.tv.apple.com/v1/hls/playlist.m3u8?referenceId=' + r.referenceId),
  'https://example.com/?a=6822052354', play + 'id=wrong&a=1881724926', 'not a URL',
];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-uts-jq-'));
const file = path.join(directory, 'uts.jq');
try {
  fs.writeFileSync(file, program);
  const jq = value => JSON.parse(execFileSync(process.env.APPLE_SUBTITLES_JQ || 'jq', ['-cf', file], {
    input: JSON.stringify(value), maxBuffer: 4 * 1024 * 1024,
  }));
  const input = { rows: urls.map(hlsUrl => ({ hlsUrl })), keep: { hlsUrl: null }, large: 'x'.repeat(2200000) };
  let expected;
  vm.runInNewContext(source, { URL, $response: { body: JSON.stringify(input) },
    $done(value) { expected = JSON.parse(value.body); } });
  assert.deepEqual(jq(input), expected);
  for (const value of [null, [], 123, false, { hlsUrl: { other: 'value' } }, { hlsUrl: 'about:blank' }]) {
    assert.deepEqual(jq(value), value);
  }
  console.log(`Embedded jq matches upstream for ${urls.length} URLs in a >2 MiB body; unmatched JSON passes through.`);
} finally {
  fs.unlinkSync(file);
  fs.rmdirSync(directory);
}
