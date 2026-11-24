import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./fitness_deepseek.js', import.meta.url), 'utf8');
const script = new vm.Script(source);
const subtitle = 'https://hls-svod.itunes.apple.com/itunes-assets/HLSVideo126/v4/a/course/P123_A456_en_subtitles_V2.m3u8';
const segment = subtitle.replace('.m3u8', '-0.webvtt');
const marked = url => url + '?__loon_fitness_zh=1';
const masterURL = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/hls/fitness/playlist.m3u8?a=456';
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",AUTOSELECT=YES,CHARACTERISTICS="public.accessibility.describes-music-and-sound,public.accessibility.transcribes-spoken-dialog",URI="' + subtitle + '"\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"\nhttps://video.example.test/video.m3u8\n';
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:60,\nP123_A456_en_subtitles_V2-0.webvtt\n#EXT-X-ENDLIST\n';
const vtt = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\nNOTE Do not alter\n\n10\n00:00:00.501 --> 00:00:02.000 line:85%\nSquat down.\n\n11\n00:00:02.100 --> 00:00:04.000\nLeft foot back.\n\n';
const store = new Map(), apiCalls = [];
function run({url = masterURL, body = master, key = 'sk-testonlynotreal', status = 200,
  apiStatus = 200, result, error, apiHangs = false, legacy = false, late = false} = {}) {
  const done = [], logs = [], timers = new Map();
  let id = 0, callback;
  const global = {
    $request:{url,headers:{Cookie:'private-apple-cookie'}},
    $argument:{deepseek_key:key,deepseek_model:'deepseek-flash',deepseek_wait:8},
    $persistentStore:{read:k=>store.get(k),write(value,k){store.set(k,value);return true;}},
    $notification:{post(){}},console:{log:value=>logs.push(value)},$done:value=>done.push(value),
    setTimeout(fn,ms){assert.equal(ms,8000);timers.set(++id,fn);return id;},
    clearTimeout(id){timers.delete(id);},
    $httpClient:{
      get(){throw new Error('Native flow must never download Apple subtitles through script HTTP');},
      post(options, cb){
        apiCalls.push(options);
        assert.equal(options.url,'https://api.deepseek.com/chat/completions');
        assert.equal(options['auto-redirect'],false);
        assert.equal(options.headers.Cookie,undefined);
        assert.equal(options.timeout,7700);
        const request=JSON.parse(options.body);
        assert.deepEqual(request.thinking,{type:'disabled'});
        assert.ok(!request.messages[1].content.includes('itunes.apple.com'));
        callback=()=>cb(error || null,{status:apiStatus},JSON.stringify(result || {
          choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:['下蹲。','左脚后撤。']})}}],
        }));
        if (!apiHangs) callback();
      },
    },
  };
  if (!legacy) global.$response={status,body};
  script.runInNewContext(global,{timeout:1000});
  if (apiHangs) for (const fn of timers.values()) fn();
  if (late) callback();
  assert.equal(done.length,1,'must complete exactly once, including delayed API callbacks');
  assert.ok(!logs.join().includes(key || 'no-key'));
  assert.equal(timers.size,0);
  return JSON.parse(JSON.stringify(done[0]));
}
assert.deepEqual(run(),{},'master stays native and never injects a new track');
assert.deepEqual(run({key:''}),{});
assert.equal(apiCalls.length,0);
assert.deepEqual(run({url:subtitle,body:playlist}),{},'native playlist remains byte-for-byte unchanged');
const translated=run({url:segment,body:vtt}).body;
assert.equal(translated,vtt.replace('Squat down.','下蹲。').replace('Left foot back.','左脚后撤。'));
assert.equal(apiCalls.length,1);
assert.equal(run({url:segment,body:vtt}).body,translated);
assert.equal(run({url:segment,body:vtt}).body,translated,'old marked sessions still work');
assert.equal(apiCalls.length,1);
assert.deepEqual(run({url:segment.replace('_en_', '_fr_'),body:vtt}),{});
assert.deepEqual(run({url:segment.replace('/itunes-assets/', '/music/'),body:vtt}),{});
assert.deepEqual(run({url:'https://example.com/music.webvtt',body:vtt}),{});
assert.deepEqual(run({url:segment,body:vtt,key:''}),{});
assert.equal(apiCalls.length,1,'unrelated content and missing keys never call API');
store.clear();
for (const apiStatus of [401,429,500]) assert.deepEqual(run({url:segment,body:vtt,apiStatus}),{});
assert.deepEqual(run({url:segment,body:vtt,error:'timeout'}),{});
assert.deepEqual(run({url:segment,body:vtt,apiHangs:true,late:true}),{});
assert.deepEqual(run({url:segment,body:vtt,result:{choices:[{finish_reason:'stop',message:{content:'{"translations":[]}'}}]}}),{});
assert.deepEqual(run({url:segment,body:'invalid VTT'}),{});
assert.deepEqual(run({url:subtitle,body:'invalid playlist'}),{});
assert.deepEqual(run({url:marked(subtitle),body:'not found',status:404}),{});
const old='https://hls-svod.itunes.apple.com/__loon_fitness_deepseek/v1/index.m3u8?src='+encodeURIComponent(subtitle);
const fallback=run({url:old,legacy:true});
assert.equal(fallback.response.status,302);
assert.equal(fallback.response.headers.Location,subtitle);
assert.equal(run({url:old.replace(encodeURIComponent(subtitle),encodeURIComponent('https://evil.example/')),legacy:true}).response.status,404);
console.log('Native Fitness+ tests passed: no master interception or Apple script downloads; Chinese-only English track; preserved timings; bounded translation; late-callback guard; immediate legacy redirect.');
