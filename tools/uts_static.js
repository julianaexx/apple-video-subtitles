// Deterministic static subtitle routing, before generic F1 registration.
function appleStaticPlayback(value) {
  if (typeof value !== 'string') return value;
  const catalog = APPLE_STATIC_CATALOG;
  const source = value.replace(/^https:\/\/play-edge-cdn\.itunes\.apple\.com/i, 'https://play-edge.itunes.apple.com')
    .replace(/^https:\/\/play-cdn\.itunes\.apple\.com/i, 'https://play.itunes.apple.com');
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?([^#]*))?$/i.exec(source);
  if (!match) return value;
  const host = match[1].toLowerCase(), path = match[2];
  const field = name => {
    const entry = (match[3] || '').split('&').find(part => part.startsWith(name + '='));
    return entry ? entry.slice(name.length + 1) : null;
  };
  const bridge = (path, revision, original = source) => 'https://hls-amt.itunes.apple.com' + path
    + '?rev=' + encodeURIComponent(revision) + '&src=' + encodeURIComponent(original);
  if (host === 'linear.tv.apple.com' && path === '/v1/hls/playlist.m3u8') {
    const preview = catalog.previews.find(row => row.referenceId === field('referenceId'));
    return preview ? bridge(preview.masterPath, preview.revision, value) : value;
  }
  if (host !== 'play.itunes.apple.com' && host !== 'play-edge.itunes.apple.com') return value;
  const episode = Object.keys(catalog.series).find(asset => value.includes(asset));
  if (episode) return bridge('/__apple_series_master/' + catalog.series[episode] + '/index.m3u8', 'dts8-20260920d');
  const replay = catalog.replays.find(row => row.programId === field('id') && row.assetId === field('a'));
  if (replay && path === '/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8') {
    return bridge('/__f1_replay_master/' + replay.slug + '/index.m3u8', replay.revision);
  }
  const movie = Object.keys(catalog.movies).find(asset => value.includes(asset));
  return movie ? bridge('/__apple_movie_master/' + catalog.movies[movie] + '/index.m3u8',
    catalog.revisions[movie] || (movie === '6796433608' ? 'v260925a' : 'v260904a')) : value;
}
