// content.js — isolated world
// 역할: main world에 injected.js를 주입하고, 양방향 메시지 브릿지 역할을 한다.

(function () {
  // 1. main world 스크립트 주입 (fetch/XHR 후킹)
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).insertBefore(script, null);
  script.onload = () => script.remove();

  // 2. injected.js ↔ content.js 메시지 처리
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__source !== 'mmig_injected') return;

    if (msg.type === 'READY') {
      // injected.js가 준비됐을 때 현재 설정을 전달
      chrome.storage.local.get('config', ({ config }) => {
        window.postMessage(
          { __source: 'mmig_content', type: 'CONFIG', config: config || {} },
          '*'
        );
      });
    } else if (msg.type === 'IDS_FOUND') {
      // 수집된 미디어 ID를 background로 전달
      chrome.runtime.sendMessage({
        type: 'MEDIA_IDS_COLLECTED',
        ids: msg.ids,
        sourceUrl: msg.sourceUrl,
      });
    }
  });

  // 3. 설정이 변경되면 injected.js에 즉시 반영
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.config) {
      window.postMessage(
        {
          __source: 'mmig_content',
          type: 'CONFIG',
          config: changes.config.newValue || {},
        },
        '*'
      );
    }
  });
})();
