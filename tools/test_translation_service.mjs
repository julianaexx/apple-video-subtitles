import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import vm from 'node:vm';
const source=readFileSync(new URL('./translation_service.js',import.meta.url),'utf8');
const credentials={translation_provider:'volcengine',volc_access_key_id:'AK-test',volc_secret_access_key:'secret-test'};
const hash=text=>createHash('sha256').update(text).digest('hex');
const hmac=(key,text)=>createHmac('sha256',key).update(text).digest();
const library={};vm.runInNewContext(source+'\nthis.lib=AppleTranslation;',library);
// Independent Node crypto implementation of the official canonical request and key derivation.
for(const secret of ['secret-test','k'.repeat(100)]){
  const request=library.lib.signedRequest('AK-test',secret,['Hello','你好 😀 '+ 'x'.repeat(1000)],7700,Date.parse('2026-11-24T02:30:40Z'));
  const date='20261124T023040Z',scope='20261124/cn-north-1/translate/request';
  assert.equal(request.headers['X-Date'],date);
  assert.equal(request.headers['X-Content-Sha256'],hash(request.body));
  const canonical='POST\n/\nAction=TranslateText&Version=2020-06-01\nhost:translate.volcengineapi.com\nx-content-sha256:'+hash(request.body)+'\nx-date:'+date+'\n\nhost;x-content-sha256;x-date\n'+hash(request.body);
  let key=secret;for(const part of ['20261124','cn-north-1','translate','request'])key=hmac(key,part);
  const signature=hmac(key,'HMAC-SHA256\n'+date+'\n'+scope+'\n'+hash(canonical)).toString('hex');
  assert.equal(request.headers.Authorization,'HMAC-SHA256 Credential=AK-test/'+scope+', SignedHeaders=host;x-content-sha256;x-date, Signature='+signature);
}
assert.equal(library.lib.create({}).ready,false);
assert.equal(library.lib.create({deepseek_key:'sk-test'}).ready,true);
assert.equal(library.lib.create({...credentials,deepseek_key:''}).ready,true);
assert.equal(library.lib.create({...credentials,translation_provider:'unknown'}).ready,false);
assert.equal(library.lib.create({...credentials,volc_secret_access_key:'bad\nkey'}).ready,false);

function scheduler(texts,respond){
  const pending=[],calls=[],accepted=[],state={now:Date.now(),remaining:8000,stop:false,completions:0};
  const context={Date:class extends Date{static now(){return state.now;}},$httpClient:{post(request,callback){calls.push(request);pending.push({request,callback});}}};
  vm.runInNewContext(source+'\nthis.service=AppleTranslation.create('+JSON.stringify(credentials)+');',context);
  context.service.translateVolc(texts.map((text,id)=>({id,text})),{
    remaining:()=>state.remaining,stopped:()=>state.stop,
    accept:(entry,value)=>accepted.push([entry.id,value]),complete:()=>state.completions++,
  });
  return {pending,calls,accepted,state,respond:respond||((job)=>job.callback(null,{status:200},JSON.stringify({TranslationList:JSON.parse(job.request.body).TextList.map(()=>({Translation:'中文'}))})))};
}
let job=scheduler(Array.from({length:60},(_,i)=>'English caption '+i));
assert.equal(job.pending.length,2);
while(job.pending.length){assert.ok(job.pending.length<=2);job.respond(job.pending.shift());}
assert.equal(job.calls.length,4);assert.equal(job.accepted.length,60);assert.equal(job.state.completions,1);
for(const request of job.calls){
  const body=JSON.parse(request.body);
  assert.ok(body.TextList.length<=16);assert.ok(body.TextList.join('').length<=5000);
  assert.equal(request.headers.Cookie,undefined);assert.equal(request['auto-redirect'],false);
}
job=scheduler(['a'.repeat(5000),'b','c'.repeat(5001),'d'.repeat(3000),'e'.repeat(2000)]);
while(job.pending.length)job.respond(job.pending.shift());
assert.equal(job.accepted.length,4);
assert.equal(job.calls.length,3);
assert.deepEqual(job.accepted.map(row=>row[0]).sort(),[0,1,3,4]);
for(const status of [401,403,429,503]){
  job=scheduler(['hello']);
  while(job.pending.length)job.pending.shift().callback(null,{status},'');
  assert.equal(job.calls.length,status===429||status===503?2:1);
  assert.equal(job.state.completions,1);
}
for(const response of ['bad json',JSON.stringify({TranslationList:[]}),JSON.stringify({ResponseMetadata:{Error:{Code:'-400'}}})]){
  job=scheduler(['hello']);job.pending.shift().callback(null,{status:200},response);
  assert.equal(job.calls.length,1);assert.equal(job.accepted.length,0);assert.equal(job.state.completions,1);
}
job=scheduler(['hello']);job.pending.shift().callback(null,{status:200},JSON.stringify({ResponseMetadata:{Error:{Code:'-429'}}}));
assert.equal(job.calls.length,2);job.respond(job.pending.shift());assert.equal(job.accepted.length,1);
job=scheduler(['hello']);job.state.remaining=500;job.pending.shift().callback('timeout',null,'');
assert.equal(job.calls.length,1);assert.equal(job.state.completions,1);
job=scheduler(Array.from({length:33},(_,i)=>'caption '+i));
job.respond(job.pending.shift());assert.equal(job.accepted.length,16);
job.state.stop=true;while(job.pending.length)job.respond(job.pending.shift());
assert.equal(job.accepted.length,16);assert.equal(job.state.completions,0,'late callbacks cannot accept or finish');
job=scheduler([]);assert.equal(job.state.completions,1);assert.equal(job.calls.length,0);

// Exercise the bundled Fitness runtime, including partial success, caches and timeout.
const fitness=readFileSync(new URL('../build/scripts/fitness-deepseek.js',import.meta.url),'utf8');
const segment='https://hls-svod.itunes.apple.com/itunes-assets/test/P123_A456_en_subtitles-0.vtt';
const originals=Array.from({length:17},(_,i)=>'English cue '+i);
const vtt='WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n'+originals.map((text,i)=>i+'\n00:00:00.000 --> 00:00:01.000\n'+text+'\n\n').join('');
const storage=new Map();
function runFitness({args=credentials,hang=false,badSecond=false,late=false}={}){
  const calls=[],pending=[],timers=new Map(),done=[],logs=[];let id=0;
  vm.runInNewContext(fitness,{
    $argument:args,$request:{url:segment,headers:{Cookie:'private-cookie'}},$response:{status:200,body:vtt},
    $persistentStore:{read:key=>storage.get(key),write(value,key){storage.set(key,value);return true;}},
    $notification:{post(){}},console:{log:text=>logs.push(text)},$done:value=>done.push(value),
    setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);},
    $httpClient:{post(request,cb){
      calls.push(request);const index=calls.length;
      const callback=()=>cb(null,{status:badSecond&&index===2?401:200},JSON.stringify({TranslationList:JSON.parse(request.body).TextList.map(()=>({Translation:'已翻译中文'}))}));
      if(hang&&index===2)pending.push(callback);else callback();
    }},
  },{timeout:1000});
  if(hang)for(const fn of timers.values())fn();
  if(late)for(const fn of pending)fn();
  assert.equal(done.length,1);assert.equal(timers.size,0);
  assert.ok(!logs.join().includes(credentials.volc_secret_access_key));
  return {body:done[0].body,calls};
}
let result=runFitness({badSecond:true});
assert.equal(result.calls.length,2);assert.ok(result.body.includes('已翻译中文'));assert.ok(result.body.includes('English cue 16'));
result=runFitness();assert.equal(result.calls.length,1,'retry only the previously failed cue');
assert.ok(!result.body.includes('English cue'));
assert.equal(runFitness().calls.length,0,'reuse cached Volc translations');
assert.equal(runFitness({args:{...credentials,translation_provider:'deepseek'}}).body,undefined,'Volc cache cannot enable missing DeepSeek credentials');
assert.equal(runFitness({args:{...credentials,volc_secret_access_key:''}}).calls.length,0);
storage.clear();result=runFitness({hang:true,late:true});
assert.ok(result.body.includes('已翻译中文'));assert.ok(result.body.includes('English cue 16'));
assert.equal([...storage.keys()].filter(key=>key.startsWith('fitness-volc-cue-')).length,16,'late callback cannot write the timed out translation');
console.log('Translation service passed: independent crypto signatures, batching, concurrency, retries, deadlines, Fitness partial results and isolated caches.');
