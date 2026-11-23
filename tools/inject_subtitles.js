// Loon response handler for a known HLS master with independent subtitle groups.
(function () {
  function attributes(line) {
    const result = {};
    const tokens = /(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
    const data = line.slice(line.indexOf(':') + 1);
    let match;
    while ((match = tokens.exec(data))) result[match[1]] = match[2] === undefined ? match[3] : match[2];
    return result;
  }

  function inject(body, config) {
    if (typeof body !== 'string' || !/^#EXTM3U(?:\r?\n)/.test(body) ||
        !/^[a-z0-9-]+$/.test(config.id) || !/^https:\/\/[^\s"\\]+$/.test(config.url)) return null;
    const lines = body.split(/\r?\n/);
    const variants = lines.filter(line => line.startsWith('#EXT-X-STREAM-INF:')).map(attributes);
    if (!variants.length || variants.some(variant => !variant.SUBTITLES)) return null;
    const tracks = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(attributes)
      .filter(track => track.TYPE === 'SUBTITLES');
    const stableID = 'local-' + config.id;
    if (tracks.some(track => track['STABLE-RENDITION-ID'] === stableID || /^zh(?:-|$)/i.test(track.LANGUAGE || ''))) {
      return null;
    }
    const output = new Map();
    for (const variant of variants) {
      const group = variant.SUBTITLES;
      const pathway = variant['PATHWAY-ID'];
      const donors = tracks.filter(track => track['GROUP-ID'] === group && track.FORCED !== 'YES' && track.URI
        && /^(en)(?:-|$)/i.test(track.LANGUAGE || '') && (!track['PATHWAY-ID'] || track['PATHWAY-ID'] === pathway));
      if (!donors.length) return null;
      const donor = donors[0];
      const donorPathway = donor['PATHWAY-ID'];
      const id = JSON.stringify([group, donorPathway]);
      if (output.has(id)) continue;
      let line = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=' + JSON.stringify(group)
        + ',NAME="简体中文",LANGUAGE="zh-Hans",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO'
        + ',STABLE-RENDITION-ID=' + JSON.stringify(stableID) + ',URI=' + JSON.stringify(config.url);
      if (donorPathway) line += ',PATHWAY-ID=' + JSON.stringify(donorPathway);
      output.set(id, line);
    }
    lines.splice(1, 0, ...output.values());
    return lines.join('\n');
  }

  let result = {};
  try {
    if (Number($response.status) === 200) {
      const config = JSON.parse(decodeURIComponent($argument));
      const body = inject($response.body, config);
      if (body) result = { body };
    }
  } catch (_) {
    console.log('Apple subtitles: custom track injection skipped');
  }
  $done(result);
})();
