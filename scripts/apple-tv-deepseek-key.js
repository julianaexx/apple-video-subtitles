// A private main-config request rule supplies the key before captions arrive.
(function () {
  const storeKey = 'apple-tv-deepseek-api-key';
  const value = typeof $argument === 'string' ? $argument.trim() : '';
  try {
    if (value === 'clear') {
      $persistentStore.write(undefined, storeKey);
      console.log('AppleTV.DeepSeek.Key 已清除本机 Key');
    } else if (/^sk-[A-Za-z0-9_-]+$/.test(value)) {
      if ($persistentStore.read(storeKey) !== value) {
        $persistentStore.write(value, storeKey);
        console.log($persistentStore.read(storeKey) === value
          ? 'AppleTV.DeepSeek.Key 本机 Key 已保存，ready 插件可读取'
          : 'AppleTV.DeepSeek.Key 本机 Key 保存失败');
      }
    } else {
      console.log('AppleTV.DeepSeek.Key 请在主配置 argument 中填写有效 Key');
    }
  } catch (_) {
    console.log('AppleTV.DeepSeek.Key 本机存储读取或写入失败');
  }
  $done({});
})();
