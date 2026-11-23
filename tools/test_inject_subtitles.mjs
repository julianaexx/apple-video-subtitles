import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('./inject_subtitles.js', import.meta.url), 'utf8');
const donor = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cc",LANGUAGE="en",NAME="English",URI="en/index.m3u8"';
const variant = '#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="cc"';
const original = '#EXTM3U\n' + donor + '\n' + variant + '\nvideo.m3u8\n';
function run(body, status = 200, argument = { id: 'sample', url: 'https://captions.example.test/vod/sample/index.m3u8' }) {
  const done = [];
  vm.runInNewContext(code, { $response: { body, status }, $argument: encodeURIComponent(JSON.stringify(argument)),
    $done(value) { done.push(value); }, console });
  assert.equal(done.length, 1);
  return JSON.parse(JSON.stringify(done[0]));
}
const changed = run(original).body;
assert.ok(changed.includes('LANGUAGE="zh-Hans"'));
assert.ok(changed.endsWith(variant + '\nvideo.m3u8\n'));
assert.ok(changed.includes(donor));
assert.deepEqual(run(changed), {});
assert.deepEqual(run(original, 503), {});
assert.deepEqual(run(original.replace('LANGUAGE="en"', 'LANGUAGE="fr"')), {});
assert.deepEqual(run(original.replace('SUBTITLES="cc"', 'SUBTITLES="unknown"')), {});
const pathways = '#EXTM3U\n' + donor + ',PATHWAY-ID="ap"\n' + donor + ',PATHWAY-ID="fa"\n'
  + variant + ',PATHWAY-ID="ap"\nvideo-ap.m3u8\n' + variant + ',PATHWAY-ID="fa"\nvideo-fa.m3u8\n';
assert.equal(run(pathways).body.match(/LANGUAGE="zh-Hans"/g).length, 2);
assert.deepEqual(run(pathways.replace(donor + ',PATHWAY-ID="fa"\n', '')), {});
console.log('Custom subtitle injection passed: groups, pathways, duplicate prevention and original playback preservation.');
