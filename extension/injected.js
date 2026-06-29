// injected.js — main world
// NCP 콘솔 세션 쿠키를 그대로 사용해 목록 API를 자동 순회한다.

(function () {
  let _config = {};

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__source !== 'mmig_content') return;

    if (msg.type === 'CONFIG') {
      _config = msg.config || {};
    } else if (msg.type === 'START_COLLECT') {
      autoCollect(msg.config || _config);
    }
  });

  // content.js에 준비 신호 → config 수신
  window.postMessage({ __source: 'mmig_injected', type: 'READY' }, '*');

  // ── 유틸 ──────────────────────────────────────────────────────────────────

  function getByPath(obj, path) {
    if (!path || obj == null) return obj;
    return path.split('.').reduce((acc, k) => acc?.[k], obj);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function post(data) {
    window.postMessage({ __source: 'mmig_injected', ...data }, '*');
  }

  // ── 자동 순회 수집 ────────────────────────────────────────────────────────

  async function autoCollect(cfg) {
    const {
      listApiUrl,
      pageParam      = 'page',
      sizeParam      = 'size',
      pageSize       = '20',
      startPage      = '0',
      contentPath    = 'content',
      totalPagesPath = 'totalPages',
      idField        = 'vodFileId',
      cdnUrlField    = 'cdnUrl',
      fileNameField  = 'fileName',
      fileSizeField  = 'fileSize',
    } = cfg;

    if (!listApiUrl) {
      post({ type: 'COLLECT_ERROR', error: '설정에서 목록 API URL을 먼저 입력하세요.' });
      return;
    }

    let page       = parseInt(startPage, 10);
    let totalPages = null;

    while (totalPages === null || page < totalPages) {
      try {
        const sep = listApiUrl.includes('?') ? '&' : '?';
        const url = `${listApiUrl}${sep}${pageParam}=${page}&${sizeParam}=${pageSize}`;

        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${url}`);
        const json = await resp.json();

        // 첫 페이지에서 전체 페이지 수 파악
        if (totalPages === null) {
          const tp = getByPath(json, totalPagesPath);
          totalPages = parseInt(tp, 10) || 1;
        }

        const raw = getByPath(json, contentPath);
        const items = (Array.isArray(raw) ? raw : [])
          .map((item) => ({
            id:       String(item[idField]       ?? ''),
            cdnUrl:   String(item[cdnUrlField]   ?? ''),
            fileName: String(item[fileNameField] ?? ''),
            fileSize: item[fileSizeField] != null ? Number(item[fileSizeField]) : null,
          }))
          .filter((item) => item.id && item.cdnUrl);

        post({
          type: 'COLLECT_PROGRESS',
          page: page + 1,
          totalPages,
          items,
        });

      } catch (err) {
        post({ type: 'COLLECT_ERROR', page, error: err.message });
        break;
      }

      page++;
      if (totalPages === null || page < totalPages) await sleep(300); // API 부하 방지
    }

    post({ type: 'COLLECT_DONE' });
  }
})();
