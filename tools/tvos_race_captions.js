// Prefer the existing race translation for matching native English segments.
function tvOSRaceCaption(match, original, finish, fallback) {
  const [, program, asset, track, index] = match;
  const replay = APPLE_TV_RACE_CAPTIONS[program + ':' + asset];
  const ordinal = Number(index) + 1;
  if (!replay || !new RegExp('^' + replay.track + '$').test(track) ||
      ordinal < 1 || ordinal > replay.segments || !/^\uFEFF?WEBVTT(?:\s|$)/.test(original)) {
    fallback();
    return;
  }

  const timingMap = raw => {
    const header = raw.trimStart().split(/\r?\n\r?\n/, 1)[0];
    const map = header.match(/^X-TIMESTAMP-MAP[ \t]*=[ \t]*([^\r\n]+)/m);
    return map ? map[1].split(',').map(item => item.trim()).sort().join(',') : '';
  };
  const cueTimes = raw => new Set((raw.match(/^\d{2,}:\d{2}(?::\d{2})?\.\d{3}[ \t]+-->[ \t]+\d{2,}:\d{2}(?::\d{2})?\.\d{3}/gm) || [])
    .map(time => time.replace(/[ \t]+/g, ' ')));
  const originalMap = timingMap(original);
  const originalTimes = cueTimes(original);
  if (!originalMap || !originalTimes.size) {
    fallback();
    return;
  }
  const cacheKey = 'apple-tv-race-vtt-' + program + '-' + asset + '-' + replay.revision;
  const pick = segments => {
    const caption = segments?.[String(ordinal).padStart(3, '0')];
    if (typeof caption !== 'string' || timingMap(caption) !== originalMap) return null;
    const translatedTimes = cueTimes(caption);
    if (translatedTimes.size === 0) return null;
    const shared = [...translatedTimes].filter(time => originalTimes.has(time)).length;
    // Edited captions can split cues. Require multiple exact intervals or
    // a clear majority when the native fragment only has one or two cues.
    return shared >= Math.min(3, Math.ceil(originalTimes.size / 2)) &&
      shared * 3 >= Math.min(originalTimes.size, translatedTimes.size) ? caption : null;
  };
  try {
    const cached = $persistentStore.read(cacheKey);
    if (cached) {
      const caption = pick(JSON.parse(cached));
      if (caption) finish({body:caption}); else fallback();
      return;
    }
  } catch (_) { /* A storage failure can still use the published captions. */ }

  let completed = false;
  const deadline = setTimeout(() => complete(null), 1600);
  function complete(caption) {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);
    if (caption) finish({body:caption}); else fallback();
  }
  try {
    $httpClient.get({
      url: replay.url, timeout: 1400, 'auto-redirect': false, 'auto-cookie': false,
    }, (error, response, body) => {
      if (completed) return;
      let caption = null;
      try {
        if (!error && Number(response?.status) === 200 && typeof body === 'string' && body.length < 800000) {
          const payload = body.match(/^const subtitles = (\{[^\r\n]*\});[ \t]*\r?$/m)?.[1];
          if (payload) {
            const segments = JSON.parse(payload);
            caption = pick(segments);
            try { $persistentStore.write(payload, cacheKey); } catch (_) {}
          }
        }
      } catch (_) { /* An unavailable or invalid asset falls back to translation. */ }
      complete(caption);
    });
  } catch (_) {
    complete(null);
  }
}
