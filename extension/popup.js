// popup.js

const $ = (id) => document.getElementById(id);

// ── 설정 필드 ────────────────────────────────────────────────────────────────

const CONFIG_KEYS = [
  'listApiUrl', 'pageParam', 'sizeParam', 'pageSize', 'startPage',
  'contentPath', 'totalPagesPath', 'idField', 'cdnUrlField',
  'fileNameField', 'fileSizeField',
  'destinationUrl', 'bearerToken', 'fieldName', 'extraIdField',
];

// ── 상태 ─────────────────────────────────────────────────────────────────────

let collectRunning = false;
let migrateRunning = false;
let logLength = 0;

// ── 초기화 ───────────────────────────────────────────────────────────────────

async function init() {
  const { config = {} } = await storage('config');
  for (const key of CONFIG_KEYS) {
    const el = $(key);
    if (el && config[key] != null) el.value = config[key];
  }

  const status = await sendBg({ type: 'GET_STATUS' });
  if (status) applyFullStatus(status);

  $('save-btn').addEventListener('click', onSave);
  $('collect-btn').addEventListener('click', onCollect);
  $('migrate-btn').addEventListener('click', onMigrate);
  $('clear-btn').addEventListener('click', onClear);

  chrome.runtime.onMessage.addListener(onBgMessage);
}

// ── 설정 저장 ────────────────────────────────────────────────────────────────

async function onSave() {
  const config = {};
  for (const key of CONFIG_KEYS) {
    const el = $(key);
    if (el) config[key] = el.value.trim();
  }
  await chrome.storage.local.set({ config });
  $('save-toast').textContent = '✓ 저장됨';
  setTimeout(() => ($('save-toast').textContent = ''), 2000);
}

// ── Phase 1: 수집 ────────────────────────────────────────────────────────────

async function onCollect() {
  if (collectRunning) return;

  const { config = {} } = await storage('config');
  if (!config.listApiUrl) {
    alert('설정에서 목록 API URL을 먼저 입력하고 저장하세요.');
    $('settings-panel').open = true;
    return;
  }

  // 현재 활성 탭의 content script로 수집 명령 전송
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { alert('활성 탭을 찾을 수 없습니다.'); return; }

  chrome.tabs.sendMessage(tab.id, { type: 'START_COLLECT', config }, (reply) => {
    if (chrome.runtime.lastError || !reply?.ok) {
      alert('NCP 콘솔 페이지가 열린 탭에서 실행해주세요.\n(페이지를 새로 고침하면 확장이 주입됩니다)');
      return;
    }
  });

  collectRunning = true;
  $('collect-btn').disabled = true;
  $('collect-btn').textContent = '수집 중...';
  $('collect-info').hidden = false;
  $('p1-num').className = 'phase-num active';
}

// ── Phase 2: 이관 ────────────────────────────────────────────────────────────

async function onMigrate() {
  if (migrateRunning) {
    // 중단
    await sendBg({ type: 'STOP_MIGRATION' });
    migrateRunning = false;
    $('migrate-btn').className = 'action-btn btn-green';
    $('migrate-btn').textContent = '이관 시작';
    return;
  }

  const { config = {} } = await storage('config');
  if (!config.destinationUrl || !config.bearerToken) {
    alert('설정에서 업로드 API URL과 Bearer 토큰을 입력하세요.');
    $('settings-panel').open = true;
    return;
  }

  migrateRunning = true;
  $('migrate-btn').className = 'action-btn btn-red';
  $('migrate-btn').textContent = '이관 중단';
  $('mig-progress').hidden = false;
  $('p2-num').className = 'phase-num active';
  logLength = 0;

  await sendBg({ type: 'START_MIGRATION', config });
}

// ── 전체 초기화 ──────────────────────────────────────────────────────────────

async function onClear() {
  if (!confirm('수집된 미디어 목록과 이관 기록을 모두 삭제할까요?')) return;
  await sendBg({ type: 'CLEAR_ALL' });
  resetCollectUI();
  resetMigUI();
}

// ── background 메시지 수신 ───────────────────────────────────────────────────

function onBgMessage(msg) {
  switch (msg.type) {
    case 'COLLECT_UPDATE':
      updateCollectProgress(msg);
      break;
    case 'COLLECT_COMPLETE':
      onCollectComplete(msg.count);
      break;
    case 'COLLECT_ERROR':
      onCollectError(msg.error);
      break;
    case 'PROGRESS_UPDATE':
      renderMigStatus(msg.status);
      break;
    case 'MIGRATION_DONE':
      onMigrationDone(msg.status);
      break;
  }
}

// ── 수집 UI 업데이트 ─────────────────────────────────────────────────────────

function updateCollectProgress({ page, totalPages, collected }) {
  $('collect-text').textContent = `${page} / ${totalPages ?? '?'} 페이지`;
  $('collect-count').textContent = `${collected}개`;
  $('p1-status').textContent = `${page} / ${totalPages ?? '?'} 페이지 처리 중`;
  if (totalPages) {
    $('collect-bar').style.width = `${Math.round((page / totalPages) * 100)}%`;
  }
}

function onCollectComplete(count) {
  collectRunning = false;
  $('collect-btn').disabled = false;
  $('collect-btn').textContent = `재수집`;
  $('p1-num').className = 'phase-num done';
  $('p1-status').textContent = `완료 — ${count}개 수집됨`;
  $('collect-bar').style.width = '100%';

  // Phase 2 활성화
  $('migrate-btn').disabled = false;
  $('p2-status').textContent = `${count}개 준비됨`;
}

function onCollectError(error) {
  collectRunning = false;
  $('collect-btn').disabled = false;
  $('collect-btn').textContent = '재시도';
  $('p1-status').textContent = `오류: ${error}`;
  $('p1-num').className = 'phase-num';
}

// ── 이관 UI 업데이트 ─────────────────────────────────────────────────────────

function renderMigStatus(s) {
  if (!s) return;
  $('s-total').textContent = s.total;
  $('s-done').textContent  = s.success;
  $('s-skip').textContent  = s.skipped;
  $('s-fail').textContent  = s.failed;

  const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
  $('mig-bar').style.width = `${pct}%`;

  if (s.inFlight > 0) $('log-cur').textContent = `처리 중: ${s.inFlight}개`;

  if ((s.log || []).length !== logLength) {
    logLength = s.log.length;
    renderLog(s.log);
  }
}

function onMigrationDone(s) {
  migrateRunning = false;
  $('migrate-btn').className = 'action-btn btn-green';
  $('migrate-btn').textContent = '이관 완료 ✓';
  $('p2-num').className = 'phase-num done';
  $('p2-status').textContent = `완료 — 성공 ${s.success} / 스킵 ${s.skipped} / 실패 ${s.failed}`;
  $('log-cur').textContent = '완료';
  renderMigStatus(s);
}

// ── 로그 렌더링 ──────────────────────────────────────────────────────────────

function renderLog(entries) {
  const box = $('log-box');
  box.innerHTML = '';
  const icons = { success: '✓', skipped: '⊘', failed: '✗' };
  for (const e of [...entries].reverse()) {
    const row = document.createElement('div');
    row.className = `le ${e.status}`;
    row.innerHTML = `
      <span class="le-icon">${icons[e.status] || '?'}</span>
      <span class="le-id" title="${e.id}">${trunc(e.id, 18)}</span>
      <span class="le-msg">${esc(logMsg(e))}</span>
    `;
    box.appendChild(row);
  }
}

function logMsg(e) {
  if (e.status === 'success') return '업로드 완료';
  if (e.status === 'skipped') return e.reason || '스킵';
  return e.error || '오류';
}

// ── 전체 상태 복원 (팝업 재오픈) ────────────────────────────────────────────

function applyFullStatus({ collect, migration }) {
  if (collect) {
    if (collect.collected > 0) {
      $('collect-info').hidden = false;
      $('collect-count').textContent = `${collect.collected}개`;
      if (collect.running) {
        collectRunning = true;
        $('collect-btn').disabled = true;
        $('collect-btn').textContent = '수집 중...';
        $('p1-num').className = 'phase-num active';
      } else {
        $('p1-num').className = 'phase-num done';
        $('p1-status').textContent = `완료 — ${collect.collected}개 수집됨`;
        $('collect-bar').style.width = '100%';
        $('collect-btn').textContent = '재수집';
        $('migrate-btn').disabled = false;
        $('p2-status').textContent = `${collect.collected}개 준비됨`;
      }
    }
  }

  if (migration && (migration.total > 0 || migration.running)) {
    $('mig-progress').hidden = false;
    renderMigStatus(migration);
    if (migration.running) {
      migrateRunning = true;
      $('migrate-btn').disabled = false;
      $('migrate-btn').className = 'action-btn btn-red';
      $('migrate-btn').textContent = '이관 중단';
      $('p2-num').className = 'phase-num active';
    } else if (migration.done === migration.total && migration.total > 0) {
      onMigrationDone(migration);
    }
  }
}

// ── 리셋 ─────────────────────────────────────────────────────────────────────

function resetCollectUI() {
  collectRunning = false;
  $('p1-num').className = 'phase-num';
  $('p1-status').textContent = 'NCP 콘솔 페이지에서 실행';
  $('collect-btn').disabled = false;
  $('collect-btn').textContent = '수집 시작';
  $('collect-info').hidden = true;
  $('collect-bar').style.width = '0%';
}

function resetMigUI() {
  migrateRunning = false;
  $('p2-num').className = 'phase-num';
  $('p2-status').textContent = '수집 후 시작 가능';
  $('migrate-btn').disabled = true;
  $('migrate-btn').className = 'action-btn btn-green';
  $('migrate-btn').textContent = '이관 시작';
  $('mig-progress').hidden = true;
  logLength = 0;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function sendBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    } catch { resolve(null); }
  });
}

function storage(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function trunc(s, n) {
  return s && s.length > n ? s.slice(0, n) + '…' : s;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 시작 ─────────────────────────────────────────────────────────────────────

init();
