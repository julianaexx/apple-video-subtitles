const raceTrackRoot = 'https://hls-amt.itunes.apple.com/__loon_race_zh/v1/';
const appleRaceMaster = /^https:\/\/play(?:-edge)?(?:-cdn)?\.itunes\.apple\.com\/WebObjects\/MZPlayLocal\.woa\/hls\/subscription\/playlist\.m3u8\?/;
const appleCaptionHost = /^(?:play(?:-edge)?(?:-cdn)?\.itunes\.apple\.com|hls(?:-amt|-svod)?\.itunes\.apple\.com|vod-(?:ap|ak|fa)-(?:amt|aoc)\.tv\.apple\.com)$/;

function raceQuery(url, key) {
  const query = url.split('?')[1] || '';
  const matches = query.split('&').filter(pair => pair.startsWith(key + '='));
  return matches.length === 1 ? decodeURIComponent(matches[0].slice(key.length + 1)) : '';
}

function raceAbsolute(uri, base) {
  if (!uri || /[\s#"\\]/.test(uri)) return '';
  if (uri.startsWith('https://')) return uri;
  if (uri.startsWith('//')) return 'https:' + uri;
  if (/^[a-z][a-z\d+.-]*:/i.test(uri)) return '';
  const [, origin, path] = /^(https:\/\/[^/]+)(\/[^?]*)/.exec(base) || [];
  if (!origin) return '';
  if (uri.startsWith('?')) return origin + path + uri;
  return origin + (uri.startsWith('/') ? uri : path.replace(/[^/]*$/, '') + uri);
}

function raceDonor(url, program, asset, replay) {
  const parts = /^https:\/\/([^/]+)(\/[^?#]+)(?:\?[^#]+)?$/.exec(url);
  if (!parts || !appleCaptionHost.test(parts[1])) return false;
  const path = parts[2];
  if (path === '/WebObjects/MZPlayLocal.woa/hls/subscription/stream/playlist.m3u8') {
    return raceQuery(url, 'p') === program && raceQuery(url, 'a') === asset &&
      (!raceQuery(url, 'mainAssetAdamId') || raceQuery(url, 'mainAssetAdamId') === asset);
  }
  return new RegExp('/P' + program + '_A' + asset + '_' + replay.track + '\\.m3u8$').test(path);
}

function addRaceTrack(body, source, program, asset, replay) {
  if (!/^#EXTM3U\r?\n/.test(body)) return '';
  const lines = body.split(/\r?\n/);
  const attrs = line => Object.fromEntries(
    [...line.slice(line.indexOf(':') + 1).matchAll(/(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)]
      .map(([, name, quoted, bare]) => [name, quoted ?? bare]),
  );
  const media = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(attrs).filter(row => row.TYPE === 'SUBTITLES');
  const variants = lines.filter(line => line.startsWith('#EXT-X-STREAM-INF:')).map(attrs);
  const added = new Map();
  for (const variant of variants) {
    const group = variant.SUBTITLES;
    if (!group) continue;
    const pathway = variant['PATHWAY-ID'] || '';
    const applicable = media.filter(row => row['GROUP-ID'] === group &&
      (!row['PATHWAY-ID'] || row['PATHWAY-ID'] === pathway));
    if (applicable.some(row => /^zh(?:-|$)/i.test(row.LANGUAGE || ''))) continue;
    const english = applicable.find(row => /^en(?:-|$)/i.test(row.LANGUAGE || '') &&
      row.FORCED !== 'YES' && raceDonor(raceAbsolute(row.URI, source), program, asset, replay));
    if (!english) continue;
    const donor = raceAbsolute(english.URI, source);
    const donorPathway = english['PATHWAY-ID'];
    const id = JSON.stringify([group, donorPathway]);
    if (added.has(id)) continue;
    const uri = raceTrackRoot + program + '_' + asset + '/index.m3u8?src=' + encodeURIComponent(donor);
    let row = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=' + JSON.stringify(group) +
      ',NAME="简体中文",LANGUAGE="zh-Hans",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO' +
      ',STABLE-RENDITION-ID="loon-race-zh-' + asset + '",URI=' + JSON.stringify(uri);
    if (donorPathway) row += ',PATHWAY-ID=' + JSON.stringify(donorPathway);
    added.set(id, row);
  }
  if (!added.size) return '';
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  return body.slice(0, body.indexOf('\n') + 1) + [...added.values()].join(newline) + newline +
    body.slice(body.indexOf('\n') + 1);
}

function raceTrackPlaylist(body, donor, program, asset, replay) {
  if (typeof body !== 'string' || !/^#EXTM3U\r?\n/.test(body)) return '';
  const segmentPattern = new RegExp('/P' + program + '_A' + asset + '_' + replay.track + '-(\\d+)\\.webvtt(?:\\?|$)');
  const root = raceTrackRoot + program + '_' + asset + '/';
  const output = [];
  let ordinal = 0;
  for (const line of body.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      output.push(line.replace(/URI="([^"]+)"/g, (tag, uri) => {
        const resolved = raceAbsolute(uri, donor);
        return resolved ? 'URI="' + resolved + '"' : tag;
      }));
      continue;
    }
    const uri = raceAbsolute(line, donor);
    if (!uri) return '';
    const match = segmentPattern.exec(uri.split('?')[0]);
    if (!match) {
      output.push(uri);
      continue;
    }
    if (Number(match[1]) !== ordinal) return '';
    ordinal++;
    if (output[output.length - 1]?.startsWith('#EXT-X-BYTERANGE:')) output.pop();
    output.push(root + 'seg-' + String(ordinal).padStart(3, '0') + '.webvtt');
  }
  return ordinal === replay.segments ? output.join('\n') : '';
}

function raceRequest(url, handle, fallback, timeout = 4800) {
  let done = false;
  const deadline = setTimeout(() => complete(), timeout);
  function complete(body) {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    if (body) {
      try { handle(body); } catch (_) { fallback(); }
    } else fallback();
  }
  try {
    $httpClient.get({url, timeout:timeout - 200, 'auto-cookie':false, 'auto-redirect':false},
      (error, response, body) => complete(!error && Number(response?.status) === 200 && typeof body === 'string' ? body : ''));
  } catch (_) {
    complete();
  }
}

function sendRaceTrack(body, type, status = 200, headers = {}) {
  $done({response:{status, headers:{'Content-Type':type, 'Cache-Control':'no-store', ...headers}, body}});
}

function handleRaceTracks() {
  const source = $request.url;
  try {
    if (typeof $response !== 'undefined' && appleRaceMaster.test(source)) {
      const program = raceQuery(source, 'id');
      const asset = raceQuery(source, 'a');
      const replay = APPLE_TV_RACE_CAPTIONS[program + ':' + asset];
      const body = replay && Number($response.status) === 200 && typeof $response.body === 'string'
        ? addRaceTrack($response.body, source, program, asset, replay) : '';
      $done(body ? {body} : {});
      return true;
    }
    if (!source.startsWith(raceTrackRoot)) return false;
    const match = /^(\d+)_(\d+)\/(index\.m3u8\?src=[^&]+|seg-(\d{3})\.webvtt)$/.exec(source.slice(raceTrackRoot.length));
    const [, program, asset, request, ordinal] = match || [];
    const replay = APPLE_TV_RACE_CAPTIONS[program + ':' + asset];
    if (!replay) {
      sendRaceTrack('', 'text/plain', 404);
      return true;
    }
    if (ordinal) {
      const empty = () => sendRaceTrack('WEBVTT\n\n', 'text/vtt; charset=utf-8');
      if (Number(ordinal) < 1 || Number(ordinal) > replay.segments) {
        empty();
        return true;
      }
      const key = 'apple-tv-race-vtt-' + program + '-' + asset + '-' + replay.revision;
      const serve = segments => {
        const caption = segments?.[ordinal];
        if (typeof caption === 'string' && /^WEBVTT(?:\s|$)/.test(caption)) {
          sendRaceTrack(caption, 'text/vtt; charset=utf-8');
        } else empty();
      };
      try {
        const cached = $persistentStore.read(key);
        if (cached) {
          serve(JSON.parse(cached));
          return true;
        }
      } catch (_) { /* Download the pinned data if the local cache is unavailable. */ }
      raceRequest(replay.url, data => {
        let segments;
        try {
          const json = data.match(/^const subtitles = (\{[^\r\n]*\});[ \t]*\r?$/m)?.[1];
          if (json && json.length < 800000) {
            segments = JSON.parse(json);
            try { $persistentStore.write(json, key); } catch (_) {}
          }
        } catch (_) {}
        serve(segments);
      }, empty);
      return true;
    }
    const donor = decodeURIComponent(request.slice('index.m3u8?src='.length));
    if (!raceDonor(donor, program, asset, replay)) {
      sendRaceTrack('', 'text/plain', 404);
      return true;
    }
    const fallback = () => sendRaceTrack('', 'application/vnd.apple.mpegurl', 302, {Location:donor});
    raceRequest(donor, body => {
      const playlist = raceTrackPlaylist(body, donor, program, asset, replay);
      if (playlist) sendRaceTrack(playlist, 'application/vnd.apple.mpegurl');
      else fallback();
    }, fallback);
    return true;
  } catch (_) {
    $done({});
    return true;
  }
}
