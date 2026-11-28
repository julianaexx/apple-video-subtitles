import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import vm from 'node:vm';
import {pinnedSource} from './upstream_source.mjs';
const decoder=readFileSync(new URL('./f1_cc608.js',import.meta.url),'utf8');
const runtime=readFileSync(new URL('../build/scripts/f1-cc-deepseek.js',import.meta.url),'utf8');
const runtimeVersion=/const VERSION='([^']+)'/.exec(runtime)[1];
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
function run(url,body,{request=false,apiFails=false,sources={},hangSource=false,fireDeadline=false,lateSource=false,key='sk-testonly',storageFails=false,apiHangs=false,apiMalformed=false,failFirst=false,apiStatus=500,translation='你好',lateApi=false,f1Wait,apiDelay=0,apiResponses=[],throwAPI=false,onPost=null,deferSingles=false,providerArgs={},logs=[]}={}){
  const results=[],timers=new Map();let at=0,late=null,latePost=null,posts=0,clockNow=Date.now();
  const deferred=[];
  vm.runInNewContext(runtime,{
    Date:class extends Date {static now(){return clockNow;}},Uint8Array,$request:{url,headers:{'User-Agent':'AppleCoreMedia test',Authorization:'apple-secret',Cookie:'account-secret'}},...(!request?{$response:{status:200,body}}:{}),
    $argument:{deepseek_key:key,deepseek_model:'deepseek-flash',deepseek_wait:8,...(f1Wait===undefined?{}:{f1_wait:f1Wait}),...providerArgs},
    $persistentStore:{read:key=>store.get(key),write(value,key){if(storageFails)return false;store.set(key,value);return true;}},
    console:{log:value=>logs.push(value)},$done:value=>results.push(value),setTimeout(fn){timers.set(++at,fn);return at;},clearTimeout(id){timers.delete(id);},
    $httpClient:{get(options,callback){
      assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);
      assert.equal(options['auto-redirect'],false);assert.equal(options.insecure,false);
      assert.ok(!options.url.includes('streaming-key-delivery'));
      assert.match(options.url,/^https:\/\/linear(?:-(?:ak|ap|fa)-[a-z0-9-]+)?\.tv\.apple\.com\//,
        'caption sources come directly from Apple, without a third-party live API');
      late=()=>Object.prototype.hasOwnProperty.call(sources,options.url)
        ?callback(null,{status:200},sources[options.url]):callback('network timeout',null,null);
      if(!hangSource)late();
    },post(options,callback){
      calls.push(options);
      const volc=providerArgs.translation_provider==='volcengine';
      assert.equal(options.url,volc?'https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01':'https://api.deepseek.com/chat/completions');
      const entries=volc?JSON.parse(options.body).TextList.map((text,id)=>({id,text})):JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
      const texts=entries.map(row=>row.text);
      const indexed=()=>volc?{TranslationList:entries.map(()=>({Translation:translation}))}:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:Object.fromEntries(entries.map(row=>[row.id,translation]))})}}]};
      posts++;
      if(onPost)onPost(posts,texts);
      if(throwAPI)throw Error('client unavailable');
      if(apiDelay>options.timeout){clockNow+=options.timeout;callback('timeout',null,null);return;}
      clockNow+=apiDelay;
      if(deferSingles&&posts>1){deferred.push(()=>callback(null,{status:200},JSON.stringify(indexed())));return;}
      if(apiResponses[posts-1]){callback(null,{status:200},JSON.stringify(apiResponses[posts-1]));return;}

      latePost=()=>callback(null,{status:200},JSON.stringify(indexed()));
      if(apiHangs)return;
      if(failFirst&&posts===1){callback(null,{status:503},'');return;}
      if(apiMalformed){callback(null,{status:200},'invalid');return;}
      callback(null,{status:apiFails?apiStatus:200},JSON.stringify(indexed()));
    }},
  },{timeout:1000});
  while(deferred.length){assert.ok(deferred.length<=2,'single-cue recovery concurrency is bounded');deferred.shift()();}
  if(fireDeadline)for(const fn of timers.values())fn();
  if(lateSource)late();
  if(lateApi&&latePost)latePost();
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
assert.ok(output.includes('简体中文（F1 AI 实验）'));
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
for(const key of [...store.keys()])if(key.startsWith('f1cc-playlist-')||key.startsWith('f1cc-segment-')||key.startsWith('f1cc-zh-')||key.startsWith('f1cc-cue-'))store.delete(key);
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
assert.ok(realResult.includes('F1 AI 实验'));
assert.equal((realResult.match(/TYPE=SUBTITLES/g)||[]).length,3,'one shared CC track per recorded Apple pathway');
assert.equal((realResult.match(/#EXT-X-STREAM-INF:/g)||[]).length,recorded.variants.length);
for(const row of restored.filter(line=>line.startsWith('#EXT-X-MEDIA:')))assert.ok(realResult.includes(row),'existing audio and CC must stay exact');
console.log('Recorded Apple master structure passed: all video/audio/iframe renditions retained; CC grouped across three CDN pathways.');

// Exercise the exact release dispatcher, with the generated static catalog.
const catalog=JSON.parse(/^const APPLE_STATIC_CATALOG = (.+);$/m.exec(runtime)[1]);
const staticURLs=[
  ...Object.keys(catalog.movies).map(a=>'https://play.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?a='+a),
  ...Object.keys(catalog.series).map(a=>'https://play-edge-cdn.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?a='+a),
  ...catalog.replays.map(row=>'https://play.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?id='+row.programId+'&a='+row.assetId),
  ...catalog.previews.map(row=>'https://linear.tv.apple.com/v1/hls/playlist.m3u8?referenceId='+row.referenceId),
  'https://example.com/?a=6822052354', 'not a URL',
];
const staticInput={rows:staticURLs.map(hlsUrl=>({hlsUrl})),keep:{hlsUrl:null}};
let expectedStatic;
vm.runInNewContext(pinnedSource('35b5421e5efa54ff5d0617bcebec57eed325158a',
  'payloads/surge/series/2019-formula-1-drive-to-survive/season-08/uts-redirect.js'),{
  URL,$response:{body:JSON.stringify(staticInput)},$done:value=>expectedStatic=JSON.parse(value.body),
});
const uts='https://uts-api.itunes.apple.com/uts/v3/sporting-events/generic';
// Sanitized fields from the Las Vegas Race in 30 capture. Condensed VOD must
// keep its current signed Apple URL instead of entering the CatchUp CC bridge.
const condensedURL='https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?cc=US&svcId=tvs.vds.241305&a=6837919154&t=fresh-test-token&id=1560312730';
const condensedPlayable={
  canonicalMetadata:{leagueShortName:'F1',shortTitle:'Las Vegas: Race in 30'},
  airingType:'OnDemand',type:'Vod',recapType:'Condensed',duration:1800,
  assets:{hlsUrl:condensedURL,fpsKeyServerUrl:keyServer,
    fpsKeyServerQueryParameters:{adamId:'6837919154',svcId:'tvs.vds.241305'}},
};
const registrationsBefore=[...store.keys()].filter(key=>key.startsWith('f1cc-event-'));
for(const playable of [
  condensedPlayable,
  {...condensedPlayable,canonicalMetadata:{leagueShortName:'F1'}},
  {...condensedPlayable,recapType:undefined},
  {...condensedPlayable,recapType:undefined,canonicalMetadata:{leagueShortName:'F1'},title:'Race in 30'},
]){
  assert.deepEqual(run(uts,JSON.stringify({data:{playables:[playable]}})),{},
    'Race in 30 must preserve the signed native playback URL and FairPlay fields');
}
assert.deepEqual([...store.keys()].filter(key=>key.startsWith('f1cc-event-')),registrationsBefore,
  'condensed VOD must not register an experimental playback entry');
// Native sports VTT has no cue ids and includes positioning and timestamp maps.
const nativeURL='https://hls-amt.itunes.apple.com/itunes-assets/HLSSportsVodVideo211/v4/aa/bb/cc/sample/P1560312730_A6837919154_en_subtitles_V2-0.webvtt';
const nativeHeader='WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000';
const nativeTiming='00:00:00.240 --> 00:00:04.560 line:0%,start position:50%,middle';
const nativeVTT=nativeHeader+'\n\n'+nativeTiming+'\nVerstappen leads the race.\n\n'+
  'second-cue\n00:00:04.860 --> 00:00:08.000\nNorris is in second place.\n\n';
let beforeNative=calls.length;
const nativeResult=run(nativeURL,nativeVTT,{translation:'测试中文'});
assert.ok(nativeResult.body.includes('测试中文'));
assert.ok(nativeResult.body.startsWith(nativeHeader+'\n\n'+nativeTiming+'\n'));
assert.ok(nativeResult.body.includes('second-cue\n00:00:04.860 --> 00:00:08.000'));
assert.equal(nativeResult.response,undefined,'native VTT uses a response body edit, not a playback redirect');
assert.equal(calls.length,beforeNative+1);
run(nativeURL+'?cache=test',nativeVTT);
assert.equal(calls.length,beforeNative+1,'native VTT reuses sentence translations across query changes');
for(const candidate of [
  nativeURL.replace('A6837919154','A999999'),nativeURL.replace('_en_','_es_'),
  nativeURL.replace('HLSSportsVodVideo211','HLSVideo211'),nativeURL.replace('hls-amt.itunes.apple.com','example.com'),
  nativeURL.replace('.webvtt','.m4s'),
])assert.deepEqual(run(candidate,nativeVTT),{},'unregistered assets, unrelated hosts and non-English/non-sports resources pass through');
assert.equal(calls.length,beforeNative+1);
assert.deepEqual(run(nativeURL,nativeHeader+'\n\n'),{body:nativeHeader+'\n\n'});
assert.deepEqual(run(nativeURL,nativeHeader+'\n\ninvalid cue'),{body:nativeHeader+'\n\ninvalid cue'});
assert.deepEqual(run(nativeURL,'not a VTT'),{});
const uncachedVTT=nativeHeader+'\n\n'+nativeTiming+'\nA new racing sentence.\n\n';
assert.deepEqual(run(nativeURL,uncachedVTT,{apiFails:true,apiStatus:401}),{body:uncachedVTT});
assert.deepEqual(run(nativeURL,uncachedVTT,{apiHangs:true,fireDeadline:true,lateApi:true}),{body:uncachedVTT},
  'timeout preserves native English exactly and ignores late translations');
assert.ok(run(nativeURL,uncachedVTT,{providerArgs:{translation_provider:'volcengine',
  volc_access_key_id:'AK-test',volc_secret_access_key:'secret-test'},translation:'火山原生字幕'}).body.includes('火山原生字幕'));
const vodKey=[...store.keys()].find(key=>key.startsWith('f1cc-vod-')&&JSON.parse(store.get(key)).asset==='6837919154');
const vodRecord=JSON.parse(store.get(vodKey));store.set(vodKey,JSON.stringify({...vodRecord,at:Date.now()-14400001}));
assert.deepEqual(run(nativeURL,nativeVTT),{},'expired native VTT registration passes through');
store.set(vodKey,JSON.stringify(vodRecord));
const capturedNative=new URL('../local/capture-1054/race-en-main-sample.vtt',import.meta.url);
if(existsSync(capturedNative)){
  const original=readFileSync(capturedNative,'utf8');
  const actual=run(nativeURL,original,{translation:'真实格式测试中文'}).body;
  assert.ok(actual.includes('真实格式测试中文'));
  assert.deepEqual(actual.split('\n').filter(line=>line.includes('-->')),
    original.split('\n').filter(line=>line.includes('-->')),'all captured timing and cue settings preserved');
  assert.equal(actual.split('\n\n')[0],original.split('\n\n')[0]);
  console.log('Private native VTT fixture passed: captured cue timing/settings and timestamp map retained.');
}
console.log('Race in 30 native VTT passed: asset scope, unchanged playback, timing/settings, providers, cache and English fallback.');
// Qualifying/practice subscription VOD lacks the Condensed/Race in 30 labels.
// Its source type, rather than the session title, must select native subtitles.
const qualifyingSource=condensedURL.replace('6837919154','900000001').replace('1560312730','900000002');
const qualifyingPlayable={canonicalMetadata:{leagueShortName:'F1',shortTitle:'Spain: Qualifying'},
  airingType:'OnDemand',type:'Vod',assets:{hlsUrl:qualifyingSource,fpsKeyServerUrl:keyServer}};
const qualifyingVTT=nativeURL.replace('6837919154','900000001').replace('1560312730','900000002');
const qualifyingBody=nativeHeader+'\n\n'+nativeTiming+'\nThe qualifying session starts now.\n\n';
assert.deepEqual(run(qualifyingVTT,qualifyingBody),{},'qualifying subtitles require F1 asset registration');
for(const title of ['Spain: Qualifying','Spain: Practice 1','Spain: Race']){
  const playable={...qualifyingPlayable,canonicalMetadata:{leagueShortName:'F1',shortTitle:title}};
  assert.deepEqual(run(uts,JSON.stringify(playable)),{},'subscription VOD keeps native playback regardless of session title');
}
assert.ok(run(qualifyingVTT,qualifyingBody,{translation:'排位赛中文'}).body.includes('排位赛中文'));
store.set('f1cc-event-abc123',JSON.stringify({identity:'asset-900000002-900000001',source:qualifyingSource,at:Date.now()}));
for(const cacheKey of [...store.keys()])if(cacheKey.startsWith('f1cc-vod-')&&JSON.parse(store.get(cacheKey)).asset==='900000001')store.delete(cacheKey);
const legacyBridge='https://hls-amt.itunes.apple.com/__loon_f1_cc/v1/abc123/master.m3u8';
assert.equal(run(legacyBridge,null,{request:true}).response.headers.Location,qualifyingSource);
assert.ok(run(qualifyingVTT,qualifyingBody).body.includes('排位赛中文'),'legacy bridge refreshes native subtitle registration');
const diagnosticLogs=[];
run(bridge,null,{request:true,sources:{[masterURL]:master.replace('#EXTM3U\n','#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="native",LANGUAGE="en",URI="secret-signed-url"\n')},logs:diagnosticLogs});
assert.ok(diagnosticLogs.some(line=>line.includes('列表含独立字幕轨')));
assert.ok(!diagnosticLogs.join('\n').includes('secret-signed-url'),'diagnostics never expose signed URLs or playlist bodies');
console.log('Subscription F1 VOD passed: qualifying/practice/replay routing, native captions, legacy bridge migration and private diagnostics.');
const mixedInput={data:{items:[
  {leagueShortName:'F1',feedName:'Race in 30',playables:[{
    ...condensedPlayable,recapType:undefined,canonicalMetadata:{leagueShortName:'F1'},
  }]},
  {playables:metadata.data.playables},
]}};
const mixedOutput=JSON.parse(run(uts,JSON.stringify(mixedInput)).body);
assert.deepEqual(mixedOutput.data.items[0],JSON.parse(JSON.stringify(mixedInput.data.items[0])),
  'inherited condensed metadata must preserve the entire playable');
assert.ok(mixedOutput.data.items[1].playables[0].assets.hlsUrl.includes('/__loon_f1_cc/'),
  'a condensed item must not disable supported replay siblings');
assert.deepEqual(JSON.parse(run(uts,JSON.stringify(staticInput),{key:''}).body),expectedStatic,
  'all static movies, series, previews and replays must match the pinned upstream routing');
const registeredStatic={canonicalMetadata:{leagueShortName:'F1'},airingType:'OnDemand',assets:{
  hlsUrl:staticURLs.find(url=>url.includes('id=1337486392')),fpsKeyServerUrl:keyServer,
}};
const routed=JSON.parse(run(uts,JSON.stringify(registeredStatic)).body);
assert.ok(routed.assets.hlsUrl.includes('/__f1_replay_master/'),'static F1 subtitles take priority over AI');
assert.equal(routed.assets.fpsKeyServerUrl,keyServer);
for(const change of [{airingType:undefined},{canonicalMetadata:{leagueShortName:'NFL'}}]){
  const value={...metadata.data.playables[0],...change};
  assert.deepEqual(run(uts,JSON.stringify(value)),{},'unknown airing types and non-F1 pass through');
}
assert.deepEqual(run(uts,JSON.stringify(metadata),{key:''}),{});
assert.deepEqual(run(uts,JSON.stringify(metadata),{storageFails:true}),{});
assert.equal(run(bridge,null,{request:true,sources:{[masterURL]:master},storageFails:true}).response.status,302);
// Refresh registration after deliberately failing storage.
run(bridge,null,{request:true,sources:{[masterURL]:master}});
function clearTranslations(){for(const key of [...store.keys()])if(key.startsWith('f1cc-zh-')||key.startsWith('f1cc-cue-'))store.delete(key);}
clearTranslations();
assert.ok(run(segmentURL,null,{request:true,apiFails:true}).response.body.includes('HELLO'));
assert.ok(run(segmentURL,null,{request:true,apiMalformed:true}).response.body.includes('HELLO'));
assert.ok(run(segmentURL,null,{request:true,apiHangs:true,fireDeadline:true,lateApi:true}).response.body.includes('HELLO'));
clearTranslations();
let beforeRetry=calls.length;
assert.ok(run(segmentURL,null,{request:true,failFirst:true}).response.body.includes('你好'));
assert.equal(calls.length-beforeRetry,2,'transient failures retry once within the same total deadline');
clearTranslations();beforeRetry=calls.length;
assert.ok(run(segmentURL,null,{request:true,apiFails:true,apiStatus:401}).response.body.includes('HELLO'));
assert.equal(calls.length-beforeRetry,1,'invalid credentials are not retried');
// Fragment time, not request order, determines decoder continuity.
function timedBinary(origin,payload=packet){
  const index=box('sidx',u32(0),u32(1),u32(1000),u32(origin),u32(0),u32(0));
  const time=box('tfdt',u32(0),u32(origin));
  let fragment=box('moof',box('traf',tfhd,time,trun(0)));
  fragment=box('moof',box('traf',tfhd,time,trun(fragment.length+8)));
  assert.equal(payload.length,packet.length);
  return new Uint8Array(Buffer.concat([index,fragment,box('mdat',payload)]));
}
run(stream+'Segment(1).m4v',timedBinary(6000));
const recordsBefore=JSON.stringify([...store].filter(([key])=>key.startsWith('f1cc-state-')));
run(stream+'Segment(0).m4v',binary);
assert.equal(JSON.stringify([...store].filter(([key])=>key.startsWith('f1cc-state-'))),recordsBefore,
  'duplicate older fragments must not rewind or reprocess decoder state');
run(stream+'Segment(3).m4v',timedBinary(18000));
run(stream+'Segment(2).m4v',timedBinary(12000));
assert.ok([...store.values()].some(value=>{const row=JSON.parse(value);return row.url===stream+'Segment(2).m4v'&&row.body.includes('MPEGTS:1080000');}));
// Identical source captions spanning fragments reuse one exact translation,
// even when the model would otherwise produce different wording.
clearCaptionState();
run(stream+'Segment(0).m4v',binary);
const resetPacket=Buffer.from(packet);resetPacket[9]=0x2c;
run(stream+'Segment(1).m4v',timedBinary(6000,resetPacket));
clearTranslations();
assert.ok(run(segmentURL,null,{request:true,translation:'第一版译文'}).response.body.includes('第一版译文'));
const secondURL=segmentURL.replace(encodeURIComponent('Segment(0).m4v'),encodeURIComponent('Segment(1).m4v'));
const beforeShared=calls.length;
assert.ok(run(secondURL,null,{request:true,translation:'不同的译文'}).response.body.includes('第一版译文'));
assert.equal(calls.length,beforeShared,'cross-fragment captions must not be retranslated');

// Adjacent roll-on prefixes become a complete stable cue; unrelated lines and
// clear-display gaps retain their original boundaries.
const stabilized=library.cc.stabilize([
  {start:0,end:0.2,text:'HE'},{start:0.2,end:0.4,text:'HELL'},
  {start:0.4,end:1,text:'HELLO'},{start:1,end:2,text:'NEXT'},
  {start:2.2,end:3,text:'NEXT WORD'},
]);
assert.equal(stabilized.length,3);assert.equal(stabilized[0].text,'HELLO');
assert.equal(stabilized[0].start,0);assert.equal(stabilized[0].end,1);

// Repair an eagerly decoded empty fragment after its predecessor becomes ready.
function clearCaptionState(){for(const key of [...store.keys()])if(key.startsWith('f1cc-state-')||key.startsWith('f1cc-segment-'))store.delete(key);}
clearCaptionState();
const empty=timedBinary(6000,Buffer.alloc(packet.length));
run(stream+'Segment(1).m4v',empty);
run(stream+'Segment(0).m4v',binary);
assert.ok(run(secondURL,null,{request:true}).response.body.includes('第一版译文'),
  'previously empty eager fragment must be decoded again using the now-ready boundary state');

// When subtitles lead the video, fetch only one previous fragment, with a short
// deadline. Do not return a permanently empty VTT for a carried caption.
clearCaptionState();
const twoSegments=media.replace('#EXT-X-ENDLIST', '#EXTINF:6,\nSegment(1).m4v\n#EXT-X-ENDLIST');
run(stream+'index.m3u8',twoSegments);
assert.ok(run(secondURL,null,{request:true,sources:{
  [stream+'Segment(0).m4v']:binary,[stream+'Segment(1).m4v']:empty,
}}).response.body.includes('第一版译文'));
// A failed new sentence must not discard a neighboring cached translation.
const slotHash=text=>{let value=2166136261;for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);return(value>>>0).toString(16);};
const mixedSource=stream+'Segment(20).m4v';
store.set('f1cc-segment-'+(parseInt(slotHash(mixedSource),16)%128),JSON.stringify({
  version:runtimeVersion,url:mixedSource,at:Date.now(),continued:true,
  body:'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n1\n00:00:00.000 --> 00:00:01.000\nHELLO\n\n2\n00:00:01.000 --> 00:00:02.000\nNEW SENTENCE\n\n',
}));
const mixedURL=segmentURL.replace(encodeURIComponent('Segment(0).m4v'),encodeURIComponent('Segment(20).m4v'));
const mixedFallback=run(mixedURL,null,{request:true,apiFails:true}).response.body;
assert.ok(mixedFallback.includes('第一版译文'));assert.ok(mixedFallback.includes('NEW SENTENCE'));
assert.ok(!mixedFallback.includes('\nHELLO\n'),'successful cached Chinese survives a later failure');
// Per-cue validation preserves successful entries and retries only missing ones.
const reply=translations=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations})}}]});
clearTranslations();
let beforePartial=calls.length;
const repaired=run(mixedURL,null,{request:true,apiResponses:[reply(['保留这句中文',null]),reply(['补译第二句'])]}).response.body;
assert.ok(repaired.includes('保留这句中文'));assert.ok(repaired.includes('补译第二句'));
assert.equal(calls.length-beforePartial,2);
assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).body).messages[1].content).subtitles,[{id:'c1',text:'NEW SENTENCE'}]);
clearTranslations();
const partial=run(mixedURL,null,{request:true,apiResponses:[reply(['保留这句中文',null]),reply([null])]}).response.body;
assert.ok(partial.includes('保留这句中文'));assert.ok(partial.includes('NEW SENTENCE'));
assert.ok(!partial.includes('\nHELLO\n'));
clearTranslations();
const englishReturned=run(segmentURL,null,{request:true,apiResponses:[reply(['HELLO']),reply(['真正的中文'])]}).response.body;
assert.ok(englishReturned.includes('真正的中文'),'unchanged English is retried rather than cached as a valid translation');
clearTranslations();
const wrappedReply={choices:[{finish_reason:'stop',message:{content:'```json\n{"translations":["中文结果"]}\n```'}}]};
assert.ok(run(segmentURL,null,{request:true,apiResponses:[wrappedReply]}).response.body.includes('中文结果'));
clearTranslations();
const slow=run(segmentURL,null,{request:true,apiDelay:10000}).response.body;
assert.ok(slow.includes('你好'),'F1 default permits a 10-second response without altering Fitness wait');
assert.equal(calls.at(-1).timeout,14700);
clearTranslations();
const bounded=run(segmentURL,null,{request:true,f1Wait:8,apiDelay:10000}).response.body;
assert.ok(bounded.includes('HELLO'),'explicit shorter F1 deadline is honored');
assert.equal(calls.at(-1).timeout,7700);
clearTranslations();
assert.ok(run(segmentURL,null,{request:true,throwAPI:true}).response.body.includes('HELLO'),
  'synchronous HTTP client errors preserve original CC rather than returning empty VTT');
// Old valid Chinese translations migrate, old English masquerading as Chinese does not.
clearTranslations();
const oldKey='f1cc-cue-v2-'+(parseInt(slotHash('deepseek-flash:HELLO'),16)%512);
store.set(oldKey,JSON.stringify({model:'deepseek-flash',text:'HELLO',translation:'旧版中文'}));
const beforeMigration=calls.length;
assert.ok(run(segmentURL,null,{request:true}).response.body.includes('旧版中文'));
assert.equal(calls.length,beforeMigration);
store.set(oldKey,JSON.stringify({model:'deepseek-flash',text:'HELLO',translation:'HELLO'}));
assert.ok(run(segmentURL,null,{request:true}).response.body.includes('你好'));
clearTranslations();
const concurrentKey='f1cc-cue-v3-'+(parseInt(slotHash('deepseek-flash:HELLO'),16)%512);
const concurrent=run(segmentURL,null,{request:true,apiFails:true,onPost:()=>{
  store.set(concurrentKey,JSON.stringify({model:'deepseek-flash',text:'HELLO',translation:'并行请求的中文'}));
}}).response.body;
assert.ok(concurrent.includes('并行请求的中文'),'a failing request rechecks successful concurrent translations before falling back');
// Reported regression: two cues receive one merged translation. Do not guess
// which timestamp owns the merged text; recover each requested id independently.
clearTranslations();
let beforeMismatch=calls.length;
const countMismatch=run(mixedURL,null,{request:true,apiResponses:[reply(['合并的译文']),reply(['第一条补译']),reply(['第二条补译'])]}).response.body;
assert.equal(calls.length-beforeMismatch,3);
assert.ok(countMismatch.includes('第一条补译'));assert.ok(countMismatch.includes('第二条补译'));
assert.ok(!countMismatch.includes('合并的译文'));
assert.deepEqual(JSON.parse(JSON.parse(calls.at(-2).body).messages[1].content).subtitles,[{id:'c0',text:'HELLO'}]);
assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).body).messages[1].content).subtitles,[{id:'c1',text:'NEW SENTENCE'}]);
clearTranslations();
const reordered=run(mixedURL,null,{request:true,apiResponses:[reply({c1:'第二条正确',c0:'第一条正确',unknown:'未知编号'})]}).response.body;
assert.ok(reordered.indexOf('第一条正确')<reordered.indexOf('第二条正确'));
clearTranslations();
const missingID=run(mixedURL,null,{request:true,apiResponses:[reply({c1:'保留第二条'}),reply({c0:'补齐第一条'})]}).response.body;
assert.ok(missingID.includes('保留第二条'));assert.ok(missingID.includes('补齐第一条'));
assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).body).messages[1].content).subtitles,[{id:'c0',text:'HELLO'}]);
clearTranslations();
const duplicateID=run(mixedURL,null,{request:true,apiResponses:[reply([
  {id:'c0',text:'重复一'},{id:'c0',text:'重复二'},{id:'c1',text:'正确第二条'},
]),reply({c0:'修复重复编号'})]}).response.body;
assert.ok(duplicateID.includes('修复重复编号'));assert.ok(duplicateID.includes('正确第二条'));
assert.ok(!duplicateID.includes('重复一'));assert.ok(!duplicateID.includes('重复二'));
clearTranslations();
const concurrentRecovery=run(mixedURL,null,{request:true,apiResponses:[reply([])],deferSingles:true}).response.body;
assert.ok(!concurrentRecovery.includes('HELLO'));assert.ok(!concurrentRecovery.includes('NEW SENTENCE'));
clearTranslations();
const cappedSource=stream+'Segment(21).m4v';
store.set('f1cc-segment-'+(parseInt(slotHash(cappedSource),16)%128),JSON.stringify({
  version:runtimeVersion,url:cappedSource,at:Date.now(),continued:true,
  body:'WEBVTT\n\n'+Array.from({length:8},(_,i)=>i+'\n00:00:00.000 --> 00:00:01.000\nWORD '+i+'\n\n').join(''),
}));
const cappedURL=segmentURL.replace(encodeURIComponent('Segment(0).m4v'),encodeURIComponent('Segment(21).m4v'));
const beforeCap=calls.length;
const capped=run(cappedURL,null,{request:true,apiResponses:[reply([])],deferSingles:true}).response.body;
assert.equal(calls.length-beforeCap,7,'one initial batch plus at most six recovery calls');
assert.ok(capped.includes('WORD 6'));assert.ok(capped.includes('WORD 7'));
console.log('Numbered F1 recovery passed: reported 2-to-1 mismatch, reordered/missing/duplicate ids, single-cue repair, concurrency and cost caps.');
console.log('F1 fallback checks passed: partial result salvage, targeted retry, English rejection, fenced JSON, independent wait limits and cache migration.');
console.log('F1 stability checks passed: cross-fragment wording, prefix coalescing, carry-in repair, bounded retry, late callbacks and partial fallback.');
console.log('Unified release routing passed: static priority, Music-safe Fitness, CC retries/seeks, API failures and playback fallbacks.');

const providerArgs={translation_provider:'volcengine',volc_access_key_id:'AK-test',volc_secret_access_key:'secret-test'};
assert.ok(JSON.parse(run('https://uts-api.itunes.apple.com/uts/v3/sporting-events/generic',JSON.stringify(metadata),{key:'',providerArgs}).body)
  .data.playables[0].assets.hlsUrl.includes('/__loon_f1_cc/'),'Volc credentials enable F1 without a DeepSeek key');
assert.deepEqual(run('https://uts-api.itunes.apple.com/uts/v3/sporting-events/generic',JSON.stringify(metadata),{
  providerArgs:{...providerArgs,volc_secret_access_key:''},
}),{},'selected Volc service must not use the available DeepSeek key');
clearTranslations();
let beforeVolc=calls.length;
let volcBody=run(mixedURL,null,{request:true,key:'',providerArgs,translation:'火山译文'}).response.body;
assert.ok(volcBody.includes('火山译文'));assert.ok(!volcBody.includes('HELLO'));assert.equal(calls.length-beforeVolc,1);
beforeVolc=calls.length;
assert.ok(run(mixedURL,null,{request:true,key:'',providerArgs}).response.body.includes('火山译文'));
assert.equal(calls.length,beforeVolc,'Volc sentence cache reused');
assert.ok(run(mixedURL,null,{request:true,translation:'独立模型译文'}).response.body.includes('独立模型译文'));
assert.equal(calls.length,beforeVolc+1,'DeepSeek must not reuse Volc sentence cache');
clearTranslations();beforeVolc=calls.length;
volcBody=run(mixedURL,null,{request:true,providerArgs,apiResponses:[{TranslationList:[{Translation:'第一句中文'},null]}]}).response.body;
assert.ok(volcBody.includes('第一句中文'));assert.ok(volcBody.includes('NEW SENTENCE'));
assert.equal(calls.length-beforeVolc,1,'malformed translations do not cause a recovery fanout');
beforeVolc=calls.length;
volcBody=run(mixedURL,null,{request:true,providerArgs,apiFails:true,apiStatus:401}).response.body;
assert.ok(volcBody.includes('第一句中文'));assert.ok(volcBody.includes('NEW SENTENCE'));
assert.equal(calls.length-beforeVolc,1,'unauthorized Volc requests are not retried');
clearTranslations();
volcBody=run(mixedURL,null,{request:true,providerArgs,apiResponses:[{TranslationList:[{Translation:'合并结果'}]}]}).response.body;
assert.ok(volcBody.includes('HELLO'));assert.ok(volcBody.includes('NEW SENTENCE'));assert.ok(!volcBody.includes('合并结果'));
clearTranslations();beforeVolc=calls.length;
assert.ok(run(mixedURL,null,{request:true,providerArgs,failFirst:true}).response.body.includes('你好'));
assert.equal(calls.length-beforeVolc,2,'retry transient Volc errors once');
clearTranslations();
volcBody=run(mixedURL,null,{request:true,providerArgs,apiHangs:true,fireDeadline:true,lateApi:true}).response.body;
assert.ok(volcBody.includes('HELLO'));assert.ok(volcBody.includes('NEW SENTENCE'));
assert.ok(![...store.keys()].some(key=>key.startsWith('f1cc-cue-')),'late Volc callback cannot cache a translation');
console.log('F1 Volc integration passed: credential routing, service/cache switching, partial results, mismatched counts, auth failure, retry and late callbacks.');

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

// A live source is discovered in Apple's UTS metadata, without /active or a
// fixed event ID. Exercise rolling windows on each supported CDN and path.
for(const delivery of ['Live','CatchUp'])for(const cdn of ['ak','ap','fa']){
  const liveMaster=masterURL.replace('generic-event','live-'+delivery+'-'+cdn);
  const liveStream=stream.replace('linear-ak-','linear-'+cdn+'-').replace('/CatchUp/','/'+delivery+'/');
  const liveMetadata={airingType:'Live',assets:{hlsUrl:liveMaster,fpsKeyServerUrl:keyServer,
    fpsKeyServerQueryParameters:{'reference-id':liveMaster.split('referenceId=')[1]}}};
  const liveRouted=JSON.parse(run(uts,JSON.stringify(liveMetadata)).body);
  const liveBridge=liveRouted.assets.hlsUrl;
  assert.ok(liveBridge.includes('/__loon_f1_cc/'));
  assert.deepEqual({...liveRouted.assets,hlsUrl:liveMaster},liveMetadata.assets,
    'live registration preserves every native authorization field');
  assert.deepEqual(run(uts,JSON.stringify(liveMetadata),{key:''}),{});
  const liveOutput=run(liveBridge,null,{request:true,sources:{[liveMaster]:master.replaceAll(stream,liveStream)}}).response.body;
  const liveList=/URI="(https:\/\/hls-amt[^" ]+)"/.exec(liveOutput)[1];
  const rolling=media.replace('#EXT-X-ENDLIST\n','');
  const first=run(liveList,null,{request:true,sources:{[liveStream+'index.m3u8']:rolling}}).response;
  assert.equal(first.status,200);
  assert.ok(!first.body.includes('#EXT-X-ENDLIST'));
  assert.ok(!first.body.includes('#EXT-X-KEY'));
  const liveSegment=first.body.split('\n').find(line=>line.startsWith('https://'));
  run(liveStream+'Segment(0).m4v',binary);
  assert.ok(run(liveSegment,null,{request:true}).response.body.includes('你好'),
    'live CC uses the configured DeepSeek translator');
  const next=rolling.replace('MEDIA-SEQUENCE:0','MEDIA-SEQUENCE:1').replace('Segment(0)','Segment(1)');
  const second=run(liveList,null,{request:true,sources:{[liveStream+'index.m3u8']:next}}).response;
  assert.equal(second.status,200);
  assert.ok(second.body.includes('#EXT-X-MEDIA-SEQUENCE:1'));
  assert.ok(second.body.includes(encodeURIComponent(liveStream+'Segment(1).m4v')));
  assert.ok(!second.body.includes(encodeURIComponent(liveStream+'Segment(0).m4v')),
    'reloads must drop segments that have left the live window');
  assert.equal(run(liveList,null,{request:true,sources:{[liveStream+'index.m3u8']:'#EXTM3U\ninvalid'}}).response.status,503,
    'malformed updates must not serve the previously cached window');
  assert.equal(run(liveList,null,{request:true}).response.status,503);
  const ended=run(liveList,null,{request:true,sources:{[liveStream+'index.m3u8']:next+'#EXT-X-ENDLIST\n'}}).response;
  assert.ok(ended.body.includes('#EXT-X-ENDLIST'));
  assert.equal(run(liveList,null,{request:true}).response.body,ended.body,
    'completed live sessions can reuse the final playlist');
  assert.equal(run(liveBridge,null,{request:true}).response.headers.Location,liveMaster);
}
const nonF1Live={airingType:'Live',canonicalMetadata:{leagueShortName:'NFL'},assets:{
  hlsUrl:masterURL.replace('umc.cmr.f1live.','umc.cmr.nfllive.')}};
assert.deepEqual(run(uts,JSON.stringify(nonF1Live)),{});
assert.ok(!runtime.includes('f1.rexchen.si'));
console.log('F1 live passed: Apple UTS discovery, three CDNs, Live/CatchUp rolling windows, DeepSeek, finalization and native fallbacks.');
