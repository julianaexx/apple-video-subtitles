import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import vm from 'node:vm';
const decoder=readFileSync(new URL('./f1_cc608.js',import.meta.url),'utf8');
const runtime=decoder+'\n'+readFileSync(new URL('./f1_cc_runtime.js',import.meta.url),'utf8');
const library={Uint8Array};vm.runInNewContext(decoder+'\nthis.cc=F1Captions;',library);
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const box=(type,...data)=>{const body=Buffer.concat(data);return Buffer.concat([u32(body.length+8),Buffer.from(type),body]);};
const packet=Buffer.from([71,65,57,52,3,0x44,255,0xfc,0x14,0x25,0xfc,72,69,0xfc,76,76,0xfc,79,32]);
const sidx=box('sidx',u32(0),u32(1),u32(1000),u32(0),u32(0),u32(0));
const tfhd=box('tfhd',u32(0x20000),u32(1));
const tfdt=box('tfdt',u32(0),u32(0));
const trun=offset=>box('trun',u32(0x301),u32(1),u32(offset),u32(6000),u32(packet.length));
let moof=box('moof',box('traf',tfhd,tfdt,trun(0)));
moof=box('moof',box('traf',tfhd,tfdt,trun(moof.length+8)));
const binary=new Uint8Array(Buffer.concat([sidx,moof,box('mdat',packet)]));
const data=library.cc.extract(binary);
assert.equal(data.duration,6);assert.equal(data.frames.length,1);
const decoded=library.cc.decode(data,null);
assert.ok(decoded.cues.some(c=>c.text==='HELLO'));
assert.ok(library.cc.webvtt(data,decoded.cues).includes('00:00:00.000 --> 00:00:06.000'));
assert.throws(()=>library.cc.extract(binary.slice(0,-2)));

const store=new Map(),calls=[];
function run(url,body,{request=false,apiFails=false,sources={},hangSource=false,fireDeadline=false,lateSource=false}={}){
  const results=[],timers=new Map();let at=0,late=null;
  vm.runInNewContext(runtime,{
    Uint8Array,$request:{url,headers:{'User-Agent':'AppleCoreMedia test',Authorization:'apple-secret',Cookie:'account-secret'}},...(!request?{$response:{status:200,body}}:{}),
    $argument:{deepseek_key:'sk-testonly',deepseek_model:'deepseek-flash',deepseek_wait:8},
    $persistentStore:{read:key=>store.get(key),write(value,key){store.set(key,value);return true;}},
    console:{log(){}},$done:value=>results.push(value),setTimeout(fn){timers.set(++at,fn);return at;},clearTimeout(id){timers.delete(id);},
    $httpClient:{get(options,callback){
      assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);
      assert.equal(options['auto-redirect'],false);assert.equal(options.insecure,false);
      assert.ok(!options.url.includes('streaming-key-delivery'));
      late=()=>Object.prototype.hasOwnProperty.call(sources,options.url)
        ?callback(null,{status:200},sources[options.url]):callback('network timeout',null,null);
      if(!hangSource)late();
    },post(options,callback){
      calls.push(options);assert.equal(options.url,'https://api.deepseek.com/chat/completions');
      const texts=JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
      callback(apiFails?'network':null,{status:apiFails?500:200},JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(()=>'你好')})}}]}));
    }},
  },{timeout:1000});
  if(fireDeadline)for(const fn of timers.values())fn();
  if(lateSource)late();
  assert.equal(results.length,1);return JSON.parse(JSON.stringify(results[0]));
}
const masterURL='https://linear.tv.apple.com/v1/hls/playlist.m3u8?referenceId=umc.cmr.f1live.sp.generic-event';
const stream='https://linear-ak-p-har-prod-a.tv.apple.com/Content/HLS_CBC/CatchUp/Channel(name=sample,startTime=0,endTime=6)/Stream(04)/';
const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",LANGUAGE="en",NAME="English",INSTREAM-ID="CC1"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1",CLOSED-CAPTIONS="cc"\n'+stream+'index.m3u8\n';
assert.deepEqual(run(masterURL,master),{},'unregistered content must remain unchanged');
const keyServer='https://linear.tv.apple.com/v1/hls/streaming-key-delivery';
const metadata={data:{playables:[{
  canonicalMetadata:{leagueShortName:'F1'},airingType:'OnDemand',assets:{hlsUrl:masterURL,fpsKeyServerUrl:keyServer},
}]}};
const rewrite=JSON.parse(run('https://uts-api.itunes.apple.com/uts/v3/sporting-events/generic',JSON.stringify(metadata)).body);
assert.equal(rewrite.data.playables[0].assets.fpsKeyServerUrl,keyServer,'FairPlay URL must stay native');
const bridge=rewrite.data.playables[0].assets.hlsUrl;
assert.ok(bridge.includes('/master.m3u8'));
const output=run(bridge,null,{request:true,sources:{[masterURL]:master}}).response.body;
assert.ok(output.includes('简体中文（F1 DeepSeek 实验）'));
assert.ok(output.includes('CODECS="avc1,wvtt"'));
assert.ok(output.includes(stream+'index.m3u8'));
assert.equal(calls.length,0);
const listURL=/URI="(https:\/\/hls-amt[^" ]+)"/.exec(output)[1];
const media='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://original"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nSegment(0).m4v\n#EXT-X-ENDLIST\n';
assert.deepEqual(run(stream+'index.m3u8',media),{});
const sidecar=run(listURL,null,{request:true}).response.body;
assert.ok(!sidecar.includes('#EXT-X-KEY'));assert.ok(!sidecar.includes('#EXT-X-MAP'));
const segmentURL=sidecar.split('\n').find(line=>line.startsWith('https://'));
assert.deepEqual(run(stream+'Segment(0).m4v',binary),{});
assert.equal(calls.length,0,'video must not wait for translation');
const translated=run(segmentURL,null,{request:true}).response.body;
assert.ok(translated.includes('你好'));assert.ok(translated.includes('X-TIMESTAMP-MAP'));
run(segmentURL,null,{request:true});assert.equal(calls.length,1,'reuse cached translation');
// Startup has a hard deadline and immediately resumes native playback on failure.
const failed=run(bridge,null,{request:true});
assert.equal(failed.response.status,302);assert.equal(failed.response.headers.Location,masterURL);
const deadline=run(bridge,null,{request:true,sources:{[masterURL]:master},hangSource:true,fireDeadline:true,lateSource:true});
assert.equal(deadline.response.status,302);
const unsupported=run(bridge,null,{request:true,sources:{[masterURL]:'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8\n'}});
assert.equal(unsupported.response.status,302,'unsupported master must preserve original playback');
const relative=master.replace(stream+'index.m3u8',stream+'index.m3u8')
  .replace('#EXTM3U\n','#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://untouched-license"\n');
assert.ok(run(bridge,null,{request:true,sources:{[masterURL]:relative}}).response.body.includes('URI="skd://untouched-license"'));
// Missing observed video/playlist must be fetched on the subtitle path, not
// permanently turned into a blank initial subtitle.
for(const key of [...store.keys()])if(key.startsWith('f1cc-playlist-')||key.startsWith('f1cc-segment-')||key.startsWith('f1cc-zh-'))store.delete(key);
const eagerList=run(listURL,null,{request:true,sources:{[stream+'index.m3u8']:media}}).response.body;
assert.ok(eagerList.includes('segment.vtt'));
assert.ok(run(segmentURL,null,{request:true,sources:{[stream+'Segment(0).m4v']:binary}}).response.body.includes('你好'));

// Reconstruct a real multivariant structure recorded in the upstream São Paulo
// payload, including its audio, iframe and multi-CDN pathway attributes.
const upstream=readFileSync(new URL('../payloads/surge/f1/previews/2026/20-sao-paulo/master.js',import.meta.url),'utf8');
const recorded=JSON.parse(/^const replayConfigs = (.+);$/m.exec(upstream)[1])[0].expectedIdentity;
const quote=(key,value)=>key+'='+(/^\d+(?:\.\d+)?$/.test(value)||/^(?:YES|NO|NONE|TYPE-\d|SDR|PQ)$/.test(value)?value:JSON.stringify(value));
const attributes=object=>Object.entries(object).filter(([key])=>!key.startsWith('_')).map(([key,value])=>quote(key,value)).join(',');
const restored=['#EXTM3U','#EXT-X-VERSION:4'];
for(const row of recorded.closedCaptions)restored.push('#EXT-X-MEDIA:'+attributes(JSON.parse(row)));
for(const row of recorded.audio){const data=JSON.parse(row);restored.push('#EXT-X-MEDIA:'+attributes({...data.attrs,URI:'https://'+data.uri}));}
for(const row of recorded.variants){const data=JSON.parse(row);restored.push('#EXT-X-STREAM-INF:'+attributes(data.attrs),'https://'+data.uri);}
for(const row of recorded.iframe){const data=JSON.parse(row);restored.push('#EXT-X-I-FRAME-STREAM-INF:'+attributes({...data.attrs,URI:'https://'+data.uri}));}
const actualMaster=restored.join('\n')+'\n';
const realResult=run(bridge,null,{request:true,sources:{[masterURL]:actualMaster}}).response.body;
assert.ok(realResult.includes('F1 DeepSeek 实验'));
assert.equal((realResult.match(/TYPE=SUBTITLES/g)||[]).length,3,'one shared CC track per recorded Apple pathway');
assert.equal((realResult.match(/#EXT-X-STREAM-INF:/g)||[]).length,recorded.variants.length);
for(const row of restored.filter(line=>line.startsWith('#EXT-X-MEDIA:')))assert.ok(realResult.includes(row),'existing audio and CC must stay exact');
console.log('Recorded Apple master structure passed: all video/audio/iframe renditions retained; CC grouped across three CDN pathways.');

// Optional private real-capture regression; never published with the runtime.
const sanitized=new URL('../tests/fixtures/f1-clear-caption-packets.json',import.meta.url);
if(existsSync(sanitized)){
  const fixture=JSON.parse(readFileSync(sanitized,'utf8'));
  let state=null,content='';
  for(const sample of fixture.samples){
    const decoded=library.cc.decode(sample,state);state=decoded.state;
    content+=decoded.cues.map(cue=>cue.text).join(' ');
  }
  assert.equal(fixture.samples.length,6);
  assert.ok(content.includes('Verstappen'));assert.ok(content.includes('Piastri'));
  console.log('Sanitized CC fixture passed on six captured frame sequences.');
}
const fixture=new URL('../local/f1-capture-test/segments.json',import.meta.url);
if(existsSync(fixture)){
  const rows=JSON.parse(readFileSync(fixture,'utf8')),items=[];
  for(const row of rows){
    const bytes=new Uint8Array(readFileSync(new URL('../local/f1-capture-test/'+row.file,import.meta.url)));
    try{items.push(library.cc.extract(bytes));}catch(_){/* Incomplete first HTTP body is expected. */}
  }
  items.sort((a,b)=>a.origin-b.origin);let state=null,text='';
  for(const item of items){const decoded=library.cc.decode(item,state);state=decoded.state;text+=decoded.cues.map(c=>c.text).join(' ');}
  assert.equal(items.length,6);assert.ok(text.includes('Verstappen'));assert.ok(text.includes('Piastri'));
  console.log('Real capture: six full video fragments decoded into timed English CC without decrypting or changing video.');
}
console.log('F1 CC experiment passed: generic event registration, master/media mapping, CC timing, video passthrough, sidecar translation and caching.');
