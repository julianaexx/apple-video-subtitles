// Extract only clear CEA-608 caption packets from fragmented MP4 samples.
// No media decryption or audio/video modification. ES runtime compatible with Loon.
const F1Captions = (function () {
  function extract(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 12582912) throw Error('binary size');
    function number(at, count) {
      if (at < 0 || at + count > bytes.length) throw Error('bounds');
      let value = 0;
      for (let i = 0; i < count; i++) value = value * 256 + bytes[at + i];
      if (!Number.isSafeInteger(value)) throw Error('timestamp range');
      return value;
    }
    const u32 = at => number(at, 4);
    const text = at => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    function boxes(start, end) {
      const result = [];
      for (let at = start; at + 8 <= end;) {
        let size = u32(at), header = 8;
        if (size === 1) { size = number(at + 8, 8); header = 16; }
        if (size === 0) size = end - at;
        if (size < header || at + size > end) throw Error('truncated box');
        result.push({type:text(at + 4),at,data:at + header,end:at + size});
        at += size;
      }
      return result;
    }
    const top = boxes(0, bytes.length);
    const sidx = top.find(box => box.type === 'sidx');
    const moof = top.find(box => box.type === 'moof');
    const mdat = top.filter(box => box.type === 'mdat');
    if (!sidx || !moof || !mdat.length) throw Error('missing timing or samples');
    const scale = u32(sidx.data + 8);
    if (!scale || ![0,1].includes(bytes[sidx.data])) throw Error('timescale');
    const presentation = number(sidx.data + 12, bytes[sidx.data] ? 8 : 4);
    const frames = [];
    let ending = presentation;
    for (const traf of boxes(moof.data, moof.end).filter(box => box.type === 'traf')) {
      const entries = boxes(traf.data, traf.end);
      const tfhd = entries.find(box => box.type === 'tfhd'), tfdt = entries.find(box => box.type === 'tfdt');
      if (!tfhd || !tfdt) continue;
      const flags = number(tfhd.data + 1, 3);
      // Avoid guessing offsets for unusual fragment layouts.
      if (!(flags & 0x20000) || (flags & 1)) throw Error('unsupported sample base');
      let at = tfhd.data + 8;
      if (flags & 2) at += 4;
      const defaultDuration = flags & 8 ? u32(at) : 0;
      if (flags & 8) at += 4;
      const defaultSize = flags & 16 ? u32(at) : 0;
      let dts = number(tfdt.data + 4, bytes[tfdt.data] ? 8 : 4);
      for (const trun of entries.filter(box => box.type === 'trun')) {
        const mask = number(trun.data + 1, 3), count = u32(trun.data + 4);
        if (!(mask & 1) || count > 5000) throw Error('sample offset or count');
        const delta = u32(trun.data + 8);
        let offset = moof.at + (delta > 0x7fffffff ? delta - 4294967296 : delta);
        at = trun.data + 12 + (mask & 4 ? 4 : 0);
        for (let i = 0; i < count; i++) {
          const duration = mask & 256 ? u32(at) : defaultDuration;
          if (mask & 256) at += 4;
          const size = mask & 512 ? u32(at) : defaultSize;
          if (mask & 512) at += 4;
          if (mask & 1024) at += 4;
          let cto = mask & 2048 ? u32(at) : 0;
          if (mask & 2048) at += 4;
          if (bytes[trun.data] === 1 && cto > 0x7fffffff) cto -= 4294967296;
          if (at > trun.end || !duration || !size || !mdat.some(box => offset >= box.data && offset + size <= box.end)) throw Error('invalid sample');
          const pts = dts + cto;
          ending = Math.max(ending, pts + duration);
          const pairs = [];
          for (let pos = offset; pos + 8 < offset + size; pos++) {
            if (bytes[pos] !== 71 || bytes[pos + 1] !== 65 || bytes[pos + 2] !== 57 || bytes[pos + 3] !== 52
                || bytes[pos + 4] !== 3 || !(bytes[pos + 5] & 64)) continue;
            const count = bytes[pos + 5] & 31;
            if (pos + 7 + count * 3 > offset + size) continue;
            for (let index = 0; index < count; index++) {
              const p = pos + 7 + index * 3;
              if ((bytes[p] & 7) === 4) pairs.push([bytes[p + 1] & 127, bytes[p + 2] & 127]);
            }
          }
          if (pairs.length) frames.push({time:(pts - presentation) / scale,pairs});
          offset += size; dts += duration;
        }
      }
    }
    frames.sort((a,b) => a.time - b.time);
    return {frames,origin:presentation / scale,duration:(ending - presentation) / scale,
      mpegts:Math.round(presentation / scale * 90000) % 8589934592};
  }
  const basicMap = {42:'á',92:'é',94:'í',95:'ó',96:'ú',123:'ç',124:'÷',125:'Ñ',126:'ñ',127:'█'};
  const special = ['®','°','½','¿','™','¢','£','♪','à',' ','è','â','ê','î','ô','û'];
  function decode(data, previous) {
    const state = previous && Math.abs(data.origin - previous.end) < 1 ? previous :
      {rows:[''],hidden:[''],mode:'roll',rowCount:2,channel:1,lastControl:''};
    let active = null;
    const cues = [];
    function visible() { return state.rows.map(row => row.trim()).filter(Boolean).join('\n'); }
    function snapshot(time) {
      const text = visible(), at = Math.max(0, Math.min(data.duration,time));
      if (active && active.text === text) return;
      if (active && at > active.start) cues.push({start:active.start,end:at,text:active.text});
      active = text ? {start:at,text} : null;
    }
    function buffer() { return state.mode === 'pop' ? state.hidden : state.rows; }
    function append(text) {
      const rows = buffer();
      if (!rows.length) rows.push('');
      rows[rows.length - 1] = (rows[rows.length - 1] + text).slice(-64);
    }
    snapshot(0);
    for (const frame of data.frames) {
      for (const [a,b] of frame.pairs) {
        if (!a && !b) continue;
        if (a >= 16 && a <= 31) {
          state.channel = a & 8 ? 2 : 1;
          if (state.channel !== 1) continue;
          const control = a + ':' + b;
          if (control === state.lastControl) { state.lastControl = ''; continue; }
          state.lastControl = control;
          const lead = a & 23;
          if (lead === 20 && b >= 32 && b <= 47) {
            if (b === 32) state.mode = 'pop';
            else if (b === 33) { const rows=buffer(); rows[rows.length-1]=(rows[rows.length-1]||'').slice(0,-1); }
            else if (b >= 37 && b <= 39) { if (state.mode !== 'roll') state.rows=['']; state.mode='roll'; state.rowCount=b-35; }
            else if (b === 41) state.mode = 'paint';
            else if (b === 44) state.rows=[''];
            else if (b === 45) { const rows=buffer(); rows.push(''); while (rows.length>state.rowCount) rows.shift(); }
            else if (b === 46) state.hidden=[''];
            else if (b === 47) { const old=state.rows;state.rows=state.hidden;state.hidden=old;state.mode='pop'; }
          } else if (lead === 17 && b >= 48 && b <= 63) append(special[b-48]);
          else if (b >= 64 && b <= 127) {
            // PAC: start a new display row for positioned pop-on captions.
            const rows=buffer();if (state.mode==='pop' && rows[rows.length-1]) rows.push('');
          }
        } else if (state.channel === 1) {
          state.lastControl='';
          for (const char of [a,b]) if (char >= 32) append(basicMap[char] || String.fromCharCode(char));
        }
      }
      snapshot(frame.time);
    }
    snapshot(data.duration);
    if (active && data.duration>active.start) cues.push({start:active.start,end:data.duration,text:active.text});
    state.end = data.origin + data.duration;
    // Keep changes lasting >=100ms; short packet transitions are not readable cues.
    const retained=cues.filter(cue=>cue.end-cue.start>=0.1);
    return {cues:retained,state};
  }
  function timestamp(seconds) {
    const ms=Math.max(0,Math.round(seconds*1000));
    return String(Math.floor(ms/3600000)).padStart(2,'0')+':'+String(Math.floor(ms/60000)%60).padStart(2,'0')
      +':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0');
  }
  function webvtt(data, cues) {
    return 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:'+data.mpegts+'\n\n'
      +cues.map((cue,i)=>String(i+1)+'\n'+timestamp(cue.start)+' --> '+timestamp(cue.end)+'\n'+cue.text+'\n\n').join('');
  }
  return {extract,decode,webvtt};
})();
