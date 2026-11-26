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

function runReplayBridge(inject) {
  const config = requestConfig($request.url);
  const upstream = config && sourceUrl(queryValue($request.url, 'src'), config);
  const type = 'application/vnd.apple.mpegurl';
  if (!upstream) {
    $done({response:{status:400, headers:{'Cache-Control':'no-store'}, body:''}});
    return;
  }
  let finished = false;
  const timer = setTimeout(() => finish(''), 4000);
  function finish(body) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const headers = {'Content-Type':type, 'Cache-Control':'no-store'};
    if (!body) headers.Location = upstream;
    $done({response:{status:body ? 200 : 302, headers, body}});
  }
  const headers = upstreamHeaders();
  // Keep the player's original Apple URL available for direct playback.
  try {
    $httpClient.get({url:upstream, headers, timeout:3700, 'auto-redirect':false, 'auto-cookie':false},
      (error, response, text) => {
        if (finished) return;
        try {
          finish(!error && Number(response?.status) === 200 && typeof text === 'string'
            ? inject(text, upstream, config) || '' : '');
        } catch (_) {
          finish('');
        }
      });
  } catch (_) {
    finish('');
  }
}
