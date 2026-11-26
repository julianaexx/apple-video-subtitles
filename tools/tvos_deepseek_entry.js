// This function is called by both the plugin and the user's private config.
function tvOSDeepSeekArguments(argument) {
  const storeKey = 'apple-tv-deepseek-api-key';
  const source = $request.url;
  const setupRequest = typeof $response === 'undefined' &&
    /^https:\/\/(?:uts-api\.itunes\.apple\.com\/uts\/|hls-svod\.itunes\.apple\.com\/itunes-assets\/[^?#]*_en_subtitles)/.test(source);
  if (setupRequest) {
    const value = typeof argument === 'string' ? argument.trim() : '';
    try {
      if (/^sk-[A-Za-z0-9_-]+$/.test(value) && $persistentStore.read(storeKey) !== value) {
        $persistentStore.write(value, storeKey);
      } else if (value === 'clear') {
        $persistentStore.write(undefined, storeKey);
      }
    } catch (_) {
      // A failed configuration write must not interrupt Apple's request.
    }
    $done({});
    return null;
  }

  let deepseekKey = '';
  try {
    deepseekKey = $persistentStore.read(storeKey) || '';
  } catch (_) {
    // Continue with Apple's English captions when storage is unavailable.
  }
  return { translation_provider: 'deepseek', deepseek_key: deepseekKey };
}
