(function () {
  const response = typeof $response === 'undefined' ? null : $response;
  if (!response || Number(response.status) !== 200 || typeof response.body !== 'string' ||
      !/^\uFEFF?WEBVTT(?:[ \t]|\r?\n|$)/.test(response.body)) {
    $done({});
    return;
  }

  const args = typeof $argument === 'object' && $argument ? $argument : {};
  const checkCode = String(args.caption_check_code ?? '').trim();
  const syncStatus = checkCode === '2468' ? '已收到检查码'
    : checkCode === 'unset' ? '检查码仍是默认值' : '未收到预期检查码';
  const provider = String(args.translation_provider ?? '').trim();
  const hasCredentials = provider === 'deepseek'
    ? /^sk-[A-Za-z0-9_-]+$/.test(String(args.deepseek_key ?? '').trim())
    : provider === 'volcengine'
      && /^[A-Za-z0-9_-]+$/.test(String(args.volc_access_key_id ?? '').trim())
      && /^[A-Za-z0-9_+=/.-]+$/.test(String(args.volc_secret_access_key ?? '').trim());
  const keyStatus = hasCredentials ? '已收到翻译参数' : '缺少有效翻译参数';
  const marker = '【脚本正常｜' + syncStatus + '｜' + keyStatus + '】 ';
  const cueTiming = /^\d{2,}:\d{2}(?::\d{2})?\.\d{3}[ \t]+-->[^\r\n]*\r?\n(?=[^\r\n])/gm;
  const body = response.body.replace(cueTiming, line => line + marker);
  $done(body === response.body ? {} : { body });
})();
