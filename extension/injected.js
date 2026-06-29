// injected.js — main world (페이지의 window와 동일한 실행 컨텍스트)
// 역할: SPA가 실행하는 fetch / XHR을 후킹하여 미디어 ID를 추출한다.

(function () {
  let config = {};

  // content.js로부터 설정 수신
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__source !== 'mmig_content') return;
    if (msg.type === 'CONFIG') {
      config = msg.config || {};
    }
  });

  // content.js에 준비 완료 신호 전송 → content.js가 설정을 보내줌
  window.postMessage({ __source: 'mmig_injected', type: 'READY' }, '*');

  // ─── 유틸 ────────────────────────────────────────────────────────────────

  function getByPath(obj, path) {
    if (!path || obj == null) return obj;
    return path.split('.').reduce((acc, k) => acc?.[k], obj);
  }

  function urlMatchesPattern(url, pattern) {
    if (!pattern) return false;
    try {
      return new RegExp(pattern).test(url);
    } catch {
      return url.includes(pattern);
    }
  }

  function extractIds(json) {
    if (!config.idJsonPath) return [];
    try {
      const arr = getByPath(json, config.idJsonPath);
      if (!Array.isArray(arr)) return [];
      const field = config.idFieldName || 'id';
      return arr
        .map((item) => (typeof item === 'object' && item !== null ? item[field] : item))
        .filter(Boolean)
        .map(String);
    } catch {
      return [];
    }
  }

  function handleJson(url, json) {
    if (!config.listApiPattern) return;
    if (!urlMatchesPattern(url, config.listApiPattern)) return;
    const ids = extractIds(json);
    if (ids.length === 0) return;
    window.postMessage(
      { __source: 'mmig_injected', type: 'IDS_FOUND', ids, sourceUrl: url },
      '*'
    );
  }

  // ─── fetch 후킹 ──────────────────────────────────────────────────────────

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _fetch.apply(this, args);
    const url =
      typeof args[0] === 'string'
        ? args[0]
        : args[0] instanceof Request
        ? args[0].url
        : String(args[0]);

    try {
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const clone = response.clone();
        clone
          .json()
          .then((json) => handleJson(url, json))
          .catch(() => {});
      }
    } catch {}

    return response;
  };

  // ─── XMLHttpRequest 후킹 ─────────────────────────────────────────────────

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mmig_url = url;
    return _open.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if (this.status < 200 || this.status >= 300) return;
      const ct = this.getResponseHeader('content-type') || '';
      if (!ct.includes('json')) return;
      try {
        const json = JSON.parse(this.responseText);
        handleJson(this.__mmig_url || '', json);
      } catch {}
    });
    return _send.apply(this, args);
  };
})();
