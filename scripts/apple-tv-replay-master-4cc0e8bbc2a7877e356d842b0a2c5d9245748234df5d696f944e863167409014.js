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

// Surge request script for exact F1 replay synthetic masters. Native
// video/audio/subtitle resources remain on their original Apple hosts.
const replayConfigs = {"australia":{"programId":"1337486392","assetId":"1881724926","revision":"f1aur22m1","stableRenditionId":"australia-2026-r22-zh-hans-m1"},"china":{"programId":"1337522687","assetId":"1881777941","revision":"f1cnr21m2","stableRenditionId":"china-2026-r21-zh-hans-m2"},"japan":{"programId":"1326620577","assetId":"1881763666","revision":"f1jpr20m1","stableRenditionId":"japan-2026-r20-zh-hans-m1"},"miami":{"programId":"1364568578","assetId":"1881733891","revision":"f1mir20m1","stableRenditionId":"miami-2026-r20-zh-hans-m1"},"canada":{"programId":"1392837560","assetId":"1881753363","revision":"f1car20m1","stableRenditionId":"canada-2026-r20-zh-hans-m1"},"monaco":{"programId":"1411825097","assetId":"1881742204","revision":"f1mcr25m1","stableRenditionId":"monaco-2026-r25-zh-hans-m1"},"barcelona-catalunya":{"programId":"1413846083","assetId":"1881690171","revision":"f1bar17m1","stableRenditionId":"barcelona-catalunya-2026-r17-zh-hans-m1"},"austria":{"programId":"1429344944","assetId":"1882150267","revision":"f1atr22m1","stableRenditionId":"austria-2026-r22-zh-hans-m1"},"great-britain":{"programId":"1436852938","assetId":"1881739464","revision":"f1gbr26m1","stableRenditionId":"great-britain-2026-r26-zh-hans-m1"},"belgium":{"programId":"1457248952","assetId":"1881786635","revision":"f1ber12m1","stableRenditionId":"belgium-2026-r12-zh-hans-m1"},"hungary":{"programId":"1461869625","assetId":"1881700068","revision":"f1hur32m1","stableRenditionId":"hungary-2026-r32-zh-hans-m1"},"netherlands":{"programId":"1478680801","assetId":"1882152939","revision":"f1ntr23m1","stableRenditionId":"netherlands-2026-r23-zh-hans-m1"},"spain":{"programId":"1497835498","assetId":"1881721455","revision":"f1spr22m1","stableRenditionId":"spain-2026-r22-zh-hans-m1"},"azerbaijan":{"programId":"1509835184","assetId":"1882094604","revision":"azr1-76f792623176","stableRenditionId":"azerbaijan-2026-r1-76f792623176"},"bahrain-malaysia":{"programId":"1526866852","programIds":["1526866852","1529375473"],"assetId":"6819360836","revision":"bhm1-57ce7a36cff3","stableRenditionId":"bahrain-malaysia-2026-r1-zh-hans-57ce7a36cff3"},"singapore":{"programId":"1525529454","assetId":"1881782888","revision":"20261024r7","stableRenditionId":"sg-zh-Hans-20261024r7"},"united-states":{"programId":"1536601273","assetId":"1881678292","revision":"20261107r6","stableRenditionId":"us-2026-zh-standard-r6"},"mexico":{"programId":"1543396071","assetId":"1882105309","revision":"f1mx20261117r6","stableRenditionId":"mx-2026-standard-r6-zh-Hans"},"sao-paulo":{"programId":"1549722223","assetId":"1881773247","revision":"f1sp20261123r1-74233bf75e98","stableRenditionId":"sao-paulo-2026-standard-r1-zh-Hans"}};

const replaySlugPattern = Object.keys(replayConfigs).join("|");

function requestConfig(value) {
  try {
    const url = new ReplayURL(value);
    const match = url.pathname.match(new RegExp(`^/__f1_replay_master/(${replaySlugPattern})/index\\.m3u8$`));
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
    if (
      url.protocol !== "https:" ||
      !/^play(?:-edge)?(?:-cdn)?\.itunes\.apple\.com$/i.test(url.hostname) ||
      url.pathname !== "/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8" ||
      !(config.programIds || [config.programId]).includes(url.searchParams.get("id")) ||
      url.searchParams.get("a") !== config.assetId
    ) return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

runReplayBridge();
