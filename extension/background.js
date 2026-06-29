// background.js — MV3 Service Worker
// Phase 1: 수집 (content→background 스트리밍)
// Phase 2: 다운로드(CDN 공개 URL, 인증 불필요) + 업로드

const CONCURRENCY   = 3;
const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_RETRIES   = 2;

// ── 수집 상태 ────────────────────────────────────────────────────────────────

let collectState = {
  running: false,
  items: [],        // { id, cdnUrl, fileName, fileSize }
  totalPages: null,
  currentPage: 0,
};

// ── 이관 상태 ────────────────────────────────────────────────────────────────

let migState = {
  running: false,
  queue: [],
  inFlight: new Set(),
  results: { success: [], skipped: [], failed: [] },
  total: 0,
  config: null,
};

// ── 메시지 핸들러 ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  switch (msg.type) {

    // ── 수집 단계 ──
    case 'COLLECT_PROGRESS':
      onCollectProgress(msg);
      reply({ ok: true });
      return true;

    case 'COLLECT_DONE':
      onCollectDone();
      reply({ ok: true });
      return true;

    case 'COLLECT_ERROR':
      onCollectError(msg.error, msg.page);
      reply({ ok: true });
      return true;

    // ── 이관 단계 ──
    case 'START_MIGRATION':
      startMigration(msg.config).then(() => reply({ ok: true }));
      return true;

    case 'STOP_MIGRATION':
      migState.running = false;
      chrome.alarms.clear('keepAlive');
      reply({ ok: true });
      return false;

    // ── 상태 조회 ──
    case 'GET_STATUS':
      reply(buildFullStatus());
      return false;

    case 'CLEAR_ALL':
      chrome.storage.local.set({ collectedItems: [] });
      collectState = { running: false, items: [], totalPages: null, currentPage: 0 };
      reply({ ok: true });
      return false;

    default:
      return false;
  }
});

// ── 알람 (서비스 워커 생존) ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(() => {});

// ── 수집 처리 ────────────────────────────────────────────────────────────────

function onCollectProgress(msg) {
  collectState.running = true;
  collectState.currentPage = msg.page;
  collectState.totalPages  = msg.totalPages;

  // 중복 없이 누적
  const existing = new Set(collectState.items.map((i) => i.id));
  for (const item of msg.items) {
    if (!existing.has(item.id)) {
      collectState.items.push(item);
      existing.add(item.id);
    }
  }

  broadcast({
    type: 'COLLECT_UPDATE',
    page: msg.page,
    totalPages: msg.totalPages,
    collected: collectState.items.length,
  });
}

function onCollectDone() {
  collectState.running = false;
  chrome.storage.local.set({ collectedItems: collectState.items });
  broadcast({
    type: 'COLLECT_COMPLETE',
    count: collectState.items.length,
  });
}

function onCollectError(error, page) {
  collectState.running = false;
  broadcast({ type: 'COLLECT_ERROR', error, page });
}

// ── 이관 엔진 ────────────────────────────────────────────────────────────────

async function startMigration(config) {
  if (migState.running) return;

  // storage에 저장된 수집 결과 사용 (팝업 재오픈 대비)
  const { collectedItems = [] } = await chrome.storage.local.get('collectedItems');
  if (collectedItems.length === 0) return;

  migState = {
    running: true,
    queue: [...collectedItems],
    inFlight: new Set(),
    results: { success: [], skipped: [], failed: [] },
    total: collectedItems.length,
    config,
  };

  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
  await runPool();
  migState.running = false;
  chrome.alarms.clear('keepAlive');
  broadcast({ type: 'MIGRATION_DONE', status: buildMigStatus() });
}

async function runPool() {
  const sem = new Semaphore(CONCURRENCY);

  await Promise.all(
    migState.queue.map(async (item) => {
      if (!migState.running) return;
      await sem.acquire();
      try {
        if (!migState.running) return;
        migState.inFlight.add(item.id);
        const result = await processItem(item, migState.config);
        recordResult(item.id, result);
      } finally {
        migState.inFlight.delete(item.id);
        sem.release();
        broadcast({ type: 'PROGRESS_UPDATE', status: buildMigStatus() });
      }
    })
  );
}

async function processItem(item, config) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    try {
      // fileSize가 이미 있으면 API 호출 불필요
      if (item.fileSize != null && item.fileSize > MAX_SIZE_BYTES) {
        return { status: 'skipped', reason: `크기 초과: ${fmt(item.fileSize)}` };
      }

      const { data, skipped, reason } = await downloadFromCdn(item);
      if (skipped) return { status: 'skipped', reason };

      await uploadToDestination(item, data, config);
      return { status: 'success' };
    } catch (err) {
      lastErr = err;
    }
  }
  return { status: 'failed', error: lastErr?.message || '알 수 없는 오류' };
}

// ── CDN 다운로드 (공개 URL, 인증 불필요) ────────────────────────────────────

async function downloadFromCdn(item) {
  const { cdnUrl, fileSize } = item;

  // fileSize 알고 있으면 바로 다운로드
  if (fileSize != null) {
    const resp = await fetch(cdnUrl);
    if (!resp.ok) throw new Error(`다운로드 실패: HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return { data: new Uint8Array(buf) };
  }

  // fileSize 모름 → HEAD 시도
  let knownSize = null;
  try {
    const r = await fetch(cdnUrl, { method: 'HEAD' });
    const cl = r.headers.get('content-length');
    if (cl) knownSize = parseInt(cl, 10);
  } catch {}

  if (knownSize == null) {
    // Range bytes=0-0
    try {
      const r = await fetch(cdnUrl, { headers: { Range: 'bytes=0-0' } });
      const cr = r.headers.get('content-range');
      if (cr) {
        const m = cr.match(/\/(\d+)$/);
        if (m) knownSize = parseInt(m[1], 10);
      }
      await r.body?.cancel();
    } catch {}
  }

  if (knownSize != null && knownSize > MAX_SIZE_BYTES) {
    return { skipped: true, reason: `크기 초과: ${fmt(knownSize)}` };
  }

  if (knownSize != null) {
    const resp = await fetch(cdnUrl);
    if (!resp.ok) throw new Error(`다운로드 실패: HTTP ${resp.status}`);
    return { data: new Uint8Array(await resp.arrayBuffer()) };
  }

  // chunked 전송 — 스트림 카운트
  const resp = await fetch(cdnUrl);
  if (!resp.ok) throw new Error(`다운로드 실패: HTTP ${resp.status}`);
  const reader = resp.body.getReader();
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
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.byteLength; }
  return { data };
}

// ── 업로드 ───────────────────────────────────────────────────────────────────

async function uploadToDestination(item, data, config) {
  const fieldName = config.fieldName || 'file';
  const filename  = item.fileName || `${item.id}.mp4`;

  const form = new FormData();
  form.append(fieldName, new Blob([data]), filename);
  if (config.extraIdField) form.append(config.extraIdField, item.id);

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

// ── 상태 빌더 ────────────────────────────────────────────────────────────────

function buildFullStatus() {
  return { collect: buildCollectStatus(), migration: buildMigStatus() };
}

function buildCollectStatus() {
  return {
    running:    collectState.running,
    collected:  collectState.items.length,
    page:       collectState.currentPage,
    totalPages: collectState.totalPages,
  };
}

function buildMigStatus() {
  const { running, results, total, inFlight } = migState;
  const done = results.success.length + results.skipped.length + results.failed.length;
  return {
    running,
    total,
    done,
    inFlight: inFlight.size,
    success:  results.success.length,
    skipped:  results.skipped.length,
    failed:   results.failed.length,
    log: [
      ...results.success.map((id) => ({ id, status: 'success' })),
      ...results.skipped.map(({ id, reason }) => ({ id, status: 'skipped', reason })),
      ...results.failed.map(({ id, error }) => ({ id, status: 'failed', error })),
    ].slice(-100),
  };
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function recordResult(id, result) {
  if (result.status === 'success')       migState.results.success.push(id);
  else if (result.status === 'skipped')  migState.results.skipped.push({ id, reason: result.reason });
  else                                   migState.results.failed.push({ id, error: result.error });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Semaphore {
  constructor(n) { this._n = n; this._q = []; }
  acquire() {
    if (this._n > 0) { this._n--; return Promise.resolve(); }
    return new Promise((r) => this._q.push(r));
  }
  release() {
    if (this._q.length > 0) this._q.shift()();
    else this._n++;
  }
}
