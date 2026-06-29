// background.js — MV3 Service Worker
// 역할: ID 수집, 서명 URL 발급, 크기 확인, 다운로드, 업로드 파이프라인

const CONCURRENCY = 3;
const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_RETRIES = 2;

// ─── 마이그레이션 상태 (메모리) ─────────────────────────────────────────────

let state = {
  running: false,
  queue: [],
  inFlight: new Set(),
  results: { success: [], skipped: [], failed: [] },
  total: 0,
  config: null,
};

// ─── 메시지 핸들러 ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  switch (msg.type) {
    case 'MEDIA_IDS_COLLECTED':
      addIds(msg.ids).then(() => reply({ ok: true }));
      return true;

    case 'GET_COLLECTED_COUNT':
      chrome.storage.local.get('collectedIds', ({ collectedIds }) =>
        reply({ count: (collectedIds || []).length })
      );
      return true;

    case 'CLEAR_IDS':
      chrome.storage.local.set({ collectedIds: [] }).then(() => reply({ ok: true }));
      return true;

    case 'START_MIGRATION':
      startMigration(msg.config).then(() => reply({ ok: true }));
      return true;

    case 'STOP_MIGRATION':
      state.running = false;
      chrome.alarms.clear('keepAlive');
      reply({ ok: true });
      return false;

    case 'GET_STATUS':
      reply(buildStatus());
      return false;

    default:
      return false;
  }
});

// ─── 알람 (서비스 워커 생존 유지) ───────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // 콜백 실행 자체로 서비스 워커가 깨어있게 된다
  }
});

// ─── ID 수집 ─────────────────────────────────────────────────────────────────

async function addIds(newIds) {
  const { collectedIds = [] } = await chrome.storage.local.get('collectedIds');
  const set = new Set(collectedIds);
  let added = 0;
  for (const id of newIds) {
    if (!set.has(String(id))) {
      set.add(String(id));
      added++;
    }
  }
  const updated = [...set];
  await chrome.storage.local.set({ collectedIds: updated });

  broadcast({ type: 'IDS_UPDATED', count: updated.length, added });
}

// ─── 마이그레이션 엔진 ──────────────────────────────────────────────────────

async function startMigration(config) {
  if (state.running) return;
  const { collectedIds = [] } = await chrome.storage.local.get('collectedIds');
  if (collectedIds.length === 0) return;

  state = {
    running: true,
    queue: [...collectedIds],
    inFlight: new Set(),
    results: { success: [], skipped: [], failed: [] },
    total: collectedIds.length,
    config,
  };

  // 서비스 워커 생존 유지 (매 24초)
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });

  await runPool();

  state.running = false;
  chrome.alarms.clear('keepAlive');
  broadcast({ type: 'MIGRATION_DONE', status: buildStatus() });
}

async function runPool() {
  // Semaphore 기반 동시성 제한
  const sem = new Semaphore(CONCURRENCY);

  const promises = state.queue.map(async (id) => {
    if (!state.running) return;
    await sem.acquire();
    try {
      if (!state.running) return;
      state.inFlight.add(id);
      const result = await processItem(id, state.config);
      recordResult(id, result);
    } finally {
      state.inFlight.delete(id);
      sem.release();
      broadcast({ type: 'PROGRESS_UPDATE', status: buildStatus() });
    }
  });

  await Promise.all(promises);
}

async function processItem(id, config) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    try {
      // 1. 서명 URL 발급 (just-in-time)
      const signedUrl = await getSignedUrl(id, config);

      // 2. 크기 확인 + 다운로드 (같은 URL로 한 번에)
      const { data, skipped, reason } = await checkSizeAndDownload(signedUrl);
      if (skipped) return { status: 'skipped', reason };

      // 3. 목적지 업로드
      await upload(id, data, config);
      return { status: 'success' };
    } catch (err) {
      lastError = err;
    }
  }
  return { status: 'failed', error: lastError?.message || '알 수 없는 오류' };
}

// ─── 서명 URL 발급 ───────────────────────────────────────────────────────────

async function getSignedUrl(id, config) {
  const endpoint = config.signedUrlEndpoint.replace('{id}', encodeURIComponent(id));
  const headers = {};
  if (config.sourceAuthHeader) headers['Authorization'] = config.sourceAuthHeader;

  const resp = await fetch(endpoint, { credentials: 'include', headers });
  if (!resp.ok) throw new Error(`서명 URL 발급 실패: HTTP ${resp.status}`);

  const json = await resp.json();
  const url = getByPath(json, config.signedUrlJsonPath);
  if (!url) throw new Error(`서명 URL 경로 오류: "${config.signedUrlJsonPath}" 에서 값 없음`);
  return url;
}

// ─── 크기 확인 + 다운로드 (폴백 체인) ──────────────────────────────────────

async function checkSizeAndDownload(url) {
  let knownSize = null;

  // [폴백 1] HEAD → Content-Length
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const cl = r.headers.get('content-length');
    if (cl) {
      knownSize = parseInt(cl, 10);
      if (knownSize > MAX_SIZE_BYTES) {
        return { skipped: true, reason: `크기 초과: ${fmt(knownSize)} (HEAD)` };
      }
    }
  } catch {}

  // [폴백 2] Range bytes=0-0 → Content-Range 전체 크기
  if (knownSize === null) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      const cr = r.headers.get('content-range');
      if (cr) {
        const m = cr.match(/\/(\d+)$/);
        if (m) {
          knownSize = parseInt(m[1], 10);
          await r.body?.cancel();
          if (knownSize > MAX_SIZE_BYTES) {
            return { skipped: true, reason: `크기 초과: ${fmt(knownSize)} (Range)` };
          }
        }
      }
    } catch {}
  }

  // 다운로드 시작
  const dlResp = await fetch(url);
  if (!dlResp.ok) throw new Error(`다운로드 실패: HTTP ${dlResp.status}`);

  if (knownSize !== null) {
    // 크기 확인됨 → ArrayBuffer 직접 수신
    const buf = await dlResp.arrayBuffer();
    return { data: new Uint8Array(buf) };
  }

  // [폴백 3] chunked 전송 → 스트림 카운트하며 100MB 초과 시 즉시 중단
  const reader = dlResp.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SIZE_BYTES) {
      await reader.cancel();
      return { skipped: true, reason: `크기 초과: ${fmt(MAX_SIZE_BYTES)}+ (스트림)` };
    }
    chunks.push(value);
  }

  // 청크 합치기
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data };
}

// ─── 업로드 ──────────────────────────────────────────────────────────────────

async function upload(id, data, config) {
  const fieldName = config.fieldName || 'file';
  const filename = (config.filenameTemplate || '{id}.mp4').replace('{id}', id);

  const form = new FormData();
  form.append(fieldName, new Blob([data]), filename);
  if (config.extraIdField) form.append(config.extraIdField, id);

  const resp = await fetch(config.destinationUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.bearerToken}` },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`업로드 실패: HTTP ${resp.status} — ${body.slice(0, 120)}`);
  }
}

// ─── 유틸 ────────────────────────────────────────────────────────────────────

function getByPath(obj, path) {
  if (!path || obj == null) return obj;
  return path.split('.').reduce((acc, k) => acc?.[k], obj);
}

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function recordResult(id, result) {
  if (result.status === 'success') state.results.success.push(id);
  else if (result.status === 'skipped')
    state.results.skipped.push({ id, reason: result.reason });
  else state.results.failed.push({ id, error: result.error });
}

function buildStatus() {
  const { running, results, total, inFlight, queue } = state;
  const done = results.success.length + results.skipped.length + results.failed.length;
  const log = [
    ...results.success.map((id) => ({ id, status: 'success' })),
    ...results.skipped.map(({ id, reason }) => ({ id, status: 'skipped', reason })),
    ...results.failed.map(({ id, error }) => ({ id, status: 'failed', error })),
  ];
  return {
    running,
    total,
    done,
    inFlight: inFlight.size,
    queued: queue.length,
    success: results.success.length,
    skipped: results.skipped.length,
    failed: results.failed.length,
    log: log.slice(-100), // 최근 100건
  };
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Semaphore ────────────────────────────────────────────────────────────────

class Semaphore {
  constructor(n) {
    this._n = n;
    this._queue = [];
  }
  acquire() {
    if (this._n > 0) {
      this._n--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._queue.push(resolve));
  }
  release() {
    if (this._queue.length > 0) {
      this._queue.shift()();
    } else {
      this._n++;
    }
  }
}
