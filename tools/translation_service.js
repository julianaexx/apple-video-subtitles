// Bundled into both Loon runtimes. No Node/WebCrypto or remote dependencies.
// Signing protocol: volcengine/volc-sdk-nodejs src/base/sign.ts (HMAC-SHA256).
const AppleTranslation = (() => {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function bytes(text) {
    const out=[];
    for(const char of text){
      let c=char.codePointAt(0);if(c>=0xd800&&c<=0xdfff)c=0xfffd;
      if(c<128)out.push(c);
      else if(c<2048)out.push(192|(c>>6),128|(c&63));
      else if(c<65536)out.push(224|(c>>12),128|((c>>6)&63),128|(c&63));
      else out.push(240|(c>>18),128|((c>>12)&63),128|((c>>6)&63),128|(c&63));
    }
    return out;
  }
  const rotate=(n,b)=>(n>>>b)|(n<<(32-b));
  const hex=data=>data.map(n=>n.toString(16).padStart(2,'0')).join('');
  function sha256(input) {
    const data=input.slice(),bits=data.length*8;
    data.push(128);while(data.length%64!==56)data.push(0);
    for(let i=7;i>=0;i--)data.push(Math.floor(bits/Math.pow(256,i))&255);
    const state=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    for(let at=0;at<data.length;at+=64){
      const w=[];
      for(let i=0;i<16;i++)w[i]=(data[at+i*4]<<24)|(data[at+i*4+1]<<16)|(data[at+i*4+2]<<8)|data[at+i*4+3];
      for(let i=16;i<64;i++){
        const a=w[i-15],b=w[i-2];
        w[i]=(w[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+w[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))|0;
      }
      let [a,b,c,d,e,f,g,h]=state;
      for(let i=0;i<64;i++){
        const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+w[i])|0;
        const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      [a,b,c,d,e,f,g,h].forEach((n,i)=>{state[i]=(state[i]+n)|0;});
    }
    const out=[];for(const n of state)out.push((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);
    return out;
  }
  function hmac(key,text) {
    if(key.length>64)key=sha256(key);
    const inner=[],outer=[];
    for(let i=0;i<64;i++){inner.push((key[i]||0)^0x36);outer.push((key[i]||0)^0x5c);}
    return sha256(outer.concat(sha256(inner.concat(bytes(text)))));
  }
  function signedRequest(ak,sk,texts,timeout,now) {
    const host='translate.volcengineapi.com',query='Action=TranslateText&Version=2020-06-01';
    const body=JSON.stringify({SourceLanguage:'en',TargetLanguage:'zh',TextList:texts});
    const date=new Date(now).toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8);
    const digest=hex(sha256(bytes(body))),scope=day+'/cn-north-1/translate/request';
    const headers='host;x-content-sha256;x-date';
    const canonical=['POST','/',query,'host:'+host+'\nx-content-sha256:'+digest+'\nx-date:'+date+'\n',headers,digest].join('\n');
    let key=bytes(sk);for(const part of [day,'cn-north-1','translate','request'])key=hmac(key,part);
    const signature=hex(hmac(key,['HMAC-SHA256',date,scope,hex(sha256(bytes(canonical)))].join('\n')));
    return {url:'https://'+host+'/?'+query,timeout,insecure:false,'auto-redirect':false,'auto-cookie':false,
      headers:{Host:host,'Content-Type':'application/json','X-Date':date,'X-Content-Sha256':digest,
        Authorization:'HMAC-SHA256 Credential='+ak+'/'+scope+', SignedHeaders='+headers+', Signature='+signature},body};
  }
  function create(args) {
    const provider=String(args.translation_provider||'deepseek').trim();
    const model=String(args.deepseek_model||'deepseek-flash').trim();
    const key=String(args.deepseek_key||'').trim();
    const ak=String(args.volc_access_key_id||'').trim(),sk=String(args.volc_secret_access_key||'').trim();
    const ready=provider==='deepseek'?/^sk-[A-Za-z0-9_-]+$/.test(key)
      :provider==='volcengine'&&/^[A-Za-z0-9_-]+$/.test(ak)&&/^[A-Za-z0-9_+=/.-]+$/.test(sk);
    const label=provider==='volcengine'?'火山引擎':provider==='deepseek'?'DeepSeek':'未知服务';
    const identity=provider==='deepseek'?'deepseek:en:zh:'+model:'volcengine:en:zh:TranslateText:2020-06-01';
    function deepseekRequest(payload,timeout) {
      return {url:'https://api.deepseek.com/chat/completions',timeout,insecure:false,'auto-redirect':false,'auto-cookie':false,
        headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload)};
    }
    // The caller owns the deadline. Each successful batch is delivered immediately,
    // so an expired/hanging neighbor cannot discard its translations.
    function translateVolc(entries,{remaining,stopped,accept,complete}) {
      const queue=[];let batch=[],size=0;
      for(const entry of entries){
        const length=entry.text.length;
        if(length>5000)continue;
        if(batch.length===16||size+length>5000){queue.push({entries:batch,attempt:0});batch=[];size=0;}
        batch.push(entry);size+=length;
      }
      if(batch.length)queue.push({entries:batch,attempt:0});
      let active=0,pumping=false,finished=false,lastReason='部分译文缺失或无效';
      function pump(){
        if(pumping||finished||stopped())return;
        pumping=true;
        while(active<2&&queue.length&&!stopped()){
          if(remaining()<600){lastReason='剩余等待不足';queue.length=0;break;}
          const job=queue.shift();active++;job.attempt++;
          let settled=false;
          function receive(error,response,text){
            if(settled||stopped())return;settled=true;active--;
            const status=response?Number(response.status)||0:0;
            let retry=status!==401&&status!==403&&(!!error||status===429||status>=500);
            if(error||status!==200)lastReason=error?'网络错误':'HTTP '+status;
            if(!error&&status===200){
              try{
                const data=JSON.parse(text),failure=data.ResponseMetadata&&data.ResponseMetadata.Error;
                if(failure){
                  retry=['-429','-500','429','500','Throttling','ThrottlingException','InternalError','InternalServerError','ServiceUnavailable'].includes(String(failure.Code));
                  lastReason=retry?'服务限流或暂不可用':'服务返回错误，请检查开通状态、权限和参数';
                }
                else if(Array.isArray(data.TranslationList)&&data.TranslationList.length===job.entries.length){
                  data.TranslationList.forEach((row,i)=>{if(row&&typeof row.Translation==='string')accept(job.entries[i],row.Translation);});
                }else lastReason='译文条数不匹配';
              }catch(_){lastReason='翻译响应格式无效';}
            }
            if(retry&&job.attempt<2&&remaining()>=600)queue.push(job);
            pump();
          }
          try{$httpClient.post(signedRequest(ak,sk,job.entries.map(row=>row.text),Math.max(300,remaining()-300),Date.now()),receive);}
          catch(_){receive('request failed',null,'');}
        }
        pumping=false;
        if(!queue.length&&!active&&!finished&&!stopped()){finished=true;complete(lastReason);}
      }
      pump();
    }
    return {provider,model,ready,label,identity,deepseekRequest,translateVolc};
  }
  return {create,signedRequest};
})();
