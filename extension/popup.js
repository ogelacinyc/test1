// popup.js

// ─── DOM 참조 ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const idCount       = $('id-count');
const clearBtn      = $('clear-btn');
const saveBtn       = $('save-btn');
const saveToast     = $('save-toast');
const startBtn      = $('start-btn');
const progressSec   = $('progress-section');
const statTotal     = $('stat-total');
const statDone      = $('stat-done');
const statSkip      = $('stat-skip');
const statFail      = $('stat-fail');
const progressBar   = $('progress-bar');
const logBox        = $('log-box');
const logCurrent    = $('log-current-item');

// ─── 설정 필드 목록 ──────────────────────────────────────────────────────────

const CONFIG_FIELDS = [
  'listApiPattern',
  'idJsonPath',
  'idFieldName',
  'signedUrlEndpoint',
  'signedUrlJsonPath',
  'destinationUrl',
  'bearerToken',
  'fieldName',
  'filenameTemplate',
];

// ─── 초기화 ──────────────────────────────────────────────────────────────────

async function init() {
  // 설정 로드
  const { config = {} } = await storageGet('config');
  for (const key of CONFIG_FIELDS) {
    const el = $(key);
    if (el && config[key] != null) el.value = config[key];
  }

  // 수집된 ID 수
  await refreshCount();

  // 진행 중인 마이그레이션 상태 확인
  const status = await sendMessage({ type: 'GET_STATUS' });
  if (status) renderStatus(status);

  updateStartBtn();
}

async function refreshCount() {
  const { count } = await sendMessage({ type: 'GET_COLLECTED_COUNT' }) || {};
  idCount.textContent = count ?? 0;
  updateStartBtn();
}

// ─── 이벤트 바인딩 ───────────────────────────────────────────────────────────

clearBtn.addEventListener('click', async () => {
  if (!confirm('수집된 ID를 모두 삭제할까요?')) return;
  await sendMessage({ type: 'CLEAR_IDS' });
  await refreshCount();
  progressSec.hidden = true;
});

saveBtn.addEventListener('click', async () => {
  const config = {};
  for (const key of CONFIG_FIELDS) {
    const el = $(key);
    if (el) config[key] = el.value.trim();
  }
  await chrome.storage.local.set({ config });

  saveToast.textContent = '✓ 저장됨';
  setTimeout(() => (saveToast.textContent = ''), 2000);
  updateStartBtn();
});

startBtn.addEventListener('click', async () => {
  const isMigrating = startBtn.classList.contains('running');

  if (isMigrating) {
    await sendMessage({ type: 'STOP_MIGRATION' });
    startBtn.classList.remove('running');
    startBtn.textContent = '이관 시작';
    return;
  }

  const { config = {} } = await storageGet('config');
  if (!config.destinationUrl || !config.bearerToken) {
    alert('설정에서 업로드 API URL과 Bearer 토큰을 먼저 입력하세요.');
    document.getElementById('settings-panel').open = true;
    return;
  }
  if (!config.signedUrlEndpoint) {
    alert('설정에서 서명 URL 발급 엔드포인트를 입력하세요.');
    document.getElementById('settings-panel').open = true;
    return;
  }

  startBtn.classList.add('running');
  startBtn.textContent = '이관 중단';
  progressSec.hidden = false;

  await sendMessage({ type: 'START_MIGRATION', config });
});

// ─── background 메시지 수신 ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'IDS_UPDATED') {
    idCount.textContent = msg.count;
    updateStartBtn();
  } else if (msg.type === 'PROGRESS_UPDATE') {
    renderStatus(msg.status);
  } else if (msg.type === 'MIGRATION_DONE') {
    renderStatus(msg.status);
    startBtn.classList.remove('running');
    startBtn.textContent = '이관 완료 ✓';
    startBtn.disabled = false;
  }
});

// ─── UI 렌더링 ────────────────────────────────────────────────────────────────

function renderStatus(status) {
  if (!status) return;

  progressSec.hidden = false;

  statTotal.textContent = status.total;
  statDone.textContent  = status.success;
  statSkip.textContent  = status.skipped;
  statFail.textContent  = status.failed;

  const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  progressBar.style.width = `${pct}%`;

  if (status.inFlight > 0) {
    logCurrent.textContent = `처리 중: ${status.inFlight}개`;
  } else if (!status.running) {
    logCurrent.textContent = `완료`;
  } else {
    logCurrent.textContent = '';
  }

  renderLog(status.log || []);

  if (status.running) {
    startBtn.classList.add('running');
    startBtn.textContent = '이관 중단';
    startBtn.disabled = false;
  } else {
    startBtn.classList.remove('running');
  }
}

let prevLogLength = 0;

function renderLog(entries) {
  if (entries.length === prevLogLength) return;
  prevLogLength = entries.length;

  logBox.innerHTML = '';
  // 최신 항목이 아래로 오도록 역순 출력
  const reversed = [...entries].reverse();
  for (const e of reversed) {
    const row = document.createElement('div');
    row.className = `log-entry le-${e.status}`;

    const iconMap = { success: '✓', skipped: '⊘', failed: '✗' };
    row.innerHTML = `
      <span class="log-icon">${iconMap[e.status] || '?'}</span>
      <span class="log-id">${truncate(e.id, 20)}</span>
      <span class="log-msg">${logMessage(e)}</span>
    `;
    logBox.appendChild(row);
  }
}

function logMessage(e) {
  if (e.status === 'success') return '업로드 완료';
  if (e.status === 'skipped') return e.reason || '스킵';
  return e.error || '오류';
}

function truncate(str, maxLen) {
  return str && str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function updateStartBtn() {
  const count = parseInt(idCount.textContent, 10) || 0;
  const isRunning = startBtn.classList.contains('running');
  startBtn.disabled = count === 0 && !isRunning;
  if (!isRunning && count > 0) {
    startBtn.textContent = `이관 시작 (${count}개)`;
  }
}

// ─── 유틸 ────────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    } catch {
      resolve(null);
    }
  });
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

// ─── 시작 ────────────────────────────────────────────────────────────────────

init();
