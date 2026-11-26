// Supply the subset of the URL API used by the pinned replay scripts on tvOS.
function ReplayURL(value, base) {
  if (typeof URL === 'function') return new URL(value, base);
  let raw = String(value);
  if (base && !/^[a-z][a-z\d+.-]*:/i.test(raw)) {
    const parent = new ReplayURL(base);
    if (raw.startsWith('//')) raw = parent.protocol + raw;
    else if (raw.startsWith('?')) raw = parent.origin + parent.pathname + raw;
    else {
      const path = raw.startsWith('/') ? raw : parent.pathname.replace(/[^/]*$/, '') + raw;
      const split = path.search(/[?#]/);
      const suffix = split < 0 ? '' : path.slice(split);
      const segments = [];
      for (const part of (split < 0 ? path : path.slice(0, split)).split('/').slice(1)) {
        if (part === '..') segments.pop();
        else if (part !== '.') segments.push(part);
      }
      raw = parent.origin + '/' + segments.join('/') + suffix;
    }
  }
  const parts = /^([a-z][a-z\d+.-]*:)\/\/([^\s/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(raw);
  if (!parts) throw new Error('Invalid HLS URL');
  this.protocol = parts[1].toLowerCase();
  this.hostname = parts[2].toLowerCase();
  this.origin = this.protocol + '//' + parts[2];
  this.pathname = parts[3] || '/';
  this.searchParams = {
    get(key) {
      for (const field of (parts[4] || '').split('&')) {
        const at = field.indexOf('=');
        if (at >= 0 && decodeURIComponent(field.slice(0, at)) === key) {
          return decodeURIComponent(field.slice(at + 1).replace(/\+/g, ' '));
        }
      }
      return null;
    },
  };
  this.toString = () => raw;
}

function runReplayBridge() {
  // Cached sessions may still request the previous synthetic HLS URL.
  // Let AVPlayer fetch Apple's original URL with its own session and headers.
  let upstream = null;
  try {
    const config = requestConfig($request.url);
    upstream = config && sourceUrl(queryValue($request.url, 'src'), config);
  } catch (_) { /* A malformed cached URL must still finish the request. */ }
  $done({response:{status:upstream ? 302 : 400, headers:{
    'Cache-Control':'no-store',
    ...(upstream ? {Location:upstream} : {}),
  }, body:''}});
}

// Surge request script for exact Chinese sidecar playlists. Synthetic VTT
// segments are mapped by playlist ordinal to each SHA-bound candidate.
const replayConfigs = {"australia":{"eventId":"P1337486392_A1881724926","programId":"1337486392","assetId":"1881724926","expectedSegments":210},"china":{"eventId":"P1337522687_A1881777941","programId":"1337522687","assetId":"1881777941","expectedSegments":226},"japan":{"eventId":"P1326620577_A1881763666","programId":"1326620577","assetId":"1881763666","expectedSegments":229},"miami":{"eventId":"P1364568578_A1881733891","programId":"1364568578","assetId":"1881733891","expectedSegments":224},"canada":{"eventId":"P1392837560_A1881753363","programId":"1392837560","assetId":"1881753363","expectedSegments":223},"monaco":{"eventId":"P1411825097_A1881742204","programId":"1411825097","assetId":"1881742204","expectedSegments":268},"barcelona-catalunya":{"eventId":"P1413846083_A1881690171","programId":"1413846083","assetId":"1881690171","expectedSegments":219},"austria":{"eventId":"P1429344944_A1882150267","programId":"1429344944","assetId":"1882150267","expectedSegments":213},"great-britain":{"eventId":"P1436852938_A1881739464","programId":"1436852938","assetId":"1881739464","expectedSegments":220},"belgium":{"eventId":"P1457248952_A1881786635","programId":"1457248952","assetId":"1881786635","expectedSegments":207},"hungary":{"eventId":"P1461869625_A1881700068","programId":"1461869625","assetId":"1881700068","expectedSegments":228},"netherlands":{"eventId":"P1478680801_A1882152939","programId":"1478680801","assetId":"1882152939","expectedSegments":254},"spain":{"eventId":"P1497835498_A1881721455","programId":"1497835498","assetId":"1881721455","expectedSegments":227},"azerbaijan":{"eventId":"P1509835184_A1882094604","programId":"1509835184","assetId":"1882094604","expectedSegments":225,"revision":"azr1-76f792623176"},"bahrain-malaysia":{"eventId":"P1526866852_A6819360836","programId":"1526866852","programIds":["1526866852","1529375473"],"assetId":"6819360836","subtitleTracks":{"1526866852":"en_subtitles_V2","1529375473":"en_subtitles_V1"},"expectedSegments":323,"revision":"bhm1-57ce7a36cff3"},"singapore":{"eventId":"P1525529454_A1881782888","programId":"1525529454","assetId":"1881782888","expectedSegments":229},"united-states":{"eventId":"P1536601273_A1881678292","programId":"1536601273","assetId":"1881678292","expectedSegments":230,"revision":"20261107r6"},"mexico":{"eventId":"P1543396071_A1882105309","programId":"1543396071","assetId":"1882105309","expectedSegments":290,"revision":"f1mx20261117r6"},"sao-paulo":{"eventId":"P1549722223_A1881773247","programId":"1549722223","assetId":"1881773247","revision":"f1sp20261123r1-74233bf75e98","expectedSegments":236,"subtitleTracks":{"1549722223":"en_subtitles_V[12]"}}};

const replaySlugPattern = Object.keys(replayConfigs).join("|");

function requestConfig(value) {
  try {
    const url = new ReplayURL(value);
    const match = url.pathname.match(new RegExp(`^/__f1_replay_zh/(${replaySlugPattern})/index\\.m3u8$`));
    if (!match) return null;
    const config = replayConfigs[match[1]];
    if (match[1] === "azerbaijan" && (url.hostname.toLowerCase() !== "hls-amt.itunes.apple.com" || url.searchParams.get("rev") !== config.revision)) return null;
    if (match[1] === "bahrain-malaysia" && (url.hostname.toLowerCase() !== "hls-amt.itunes.apple.com" || url.searchParams.get("rev") !== config.revision)) return null;
    return { slug: match[1], ...config };
  } catch (_) { return null; }
}

function queryValue(url, key) {
  try { return new ReplayURL(url).searchParams.get(key) || ""; } catch (_) { return ""; }
}

function sourceUrl(value, config) {
  try {
    const url = new ReplayURL(value);
    const exactSubscriptionStream =
      /^play(?:-edge)?(?:-cdn)?\.itunes\.apple\.com$/i.test(url.hostname) &&
      url.pathname === "/WebObjects/MZPlayLocal.woa/hls/subscription/stream/playlist.m3u8";
    const exactBinding =
      url.searchParams.get("a") === config.assetId &&
      url.searchParams.get("mainAssetAdamId") === config.assetId &&
      (config.programIds || [config.programId]).includes(url.searchParams.get("p")) &&
      /^(?:vod-ap-aoc|vod-fa-aoc|vod-ak-aoc)\.tv\.apple\.com$/i.test(url.searchParams.get("cdn") || "");
    return url.protocol === "https:" && exactSubscriptionStream && exactBinding ? url.toString() : null;
  } catch (_) { return null; }
}

runReplayBridge();
