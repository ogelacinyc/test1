// content.js — isolated world 브릿지
// popup/background ↔ content.js ↔ injected.js (main world)

(function () {
  // 1. main world 스크립트 주입
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).insertBefore(script, null);
  script.onload = () => script.remove();

  // 2. injected.js → content.js 메시지 처리
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__source !== 'mmig_injected') return;

    if (msg.type === 'READY') {
      // 설정 전달
      chrome.storage.local.get('config', ({ config }) => {
        postToPage({ type: 'CONFIG', config: config || {} });
      });
    } else {
      // COLLECT_PROGRESS / COLLECT_DONE / COLLECT_ERROR → background 전달
      chrome.runtime.sendMessage(msg).catch(() => {});
    }
  });

  // 3. popup → content.js (chrome.tabs.sendMessage) → injected.js
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'START_COLLECT') {
      postToPage({ type: 'START_COLLECT', config: msg.config });
      reply({ ok: true });
      return true;
    }
  });

  // 4. 설정 변경 실시간 반영
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.config) {
      postToPage({ type: 'CONFIG', config: changes.config.newValue || {} });
    }
  });

  function postToPage(data) {
    window.postMessage({ __source: 'mmig_content', ...data }, '*');
  }
})();
