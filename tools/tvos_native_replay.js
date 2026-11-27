// Restore a cached bridge's original signed URL without re-encoding its query.
function tvOSOriginalReplay(value) {
  const match = APPLE_TV_LEGACY_REPLAY.exec(value);
  if (!match?.[1]) return null;
  const fields = match[1].split('&').filter(field => field.startsWith('src='));
  if (fields.length !== 1) return null;
  try {
    const original = decodeURIComponent(fields[0].slice(4));
    const apple = /^https:\/\/play(?:-edge)?(?:-cdn)?\.itunes\.apple\.com\/WebObjects\/MZPlayLocal\.woa\/hls\/subscription\/playlist\.m3u8\?([^#\s]+)$/.exec(original);
    if (!apple) return null;
    const query = apple[1].split('&');
    const id = name => {
      const field = query.filter(item => item.startsWith(name + '='));
      return field.length === 1 ? decodeURIComponent(field[0].slice(name.length + 1)) : '';
    };
    return APPLE_TV_RACE_CAPTIONS[id('id') + ':' + id('a')] ? original : null;
  } catch (_) {
    return null;
  }
}
