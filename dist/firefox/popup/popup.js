// SAM - Suno Archive Manager — Popup Script (scroll-based scan)
'use strict';

let state = 'offsite';
let activeTabId = null;
let isPaused = false;
let pollInterval = null;
let scrollCompleteTimer = null;
let waitingForLibraryLoad = false;

function isSunoPage(url) {
  return /^https:\/\/[^/]*\.?suno\.(com|ai)/.test(url || '');
}

const views = {
  offsite:  document.getElementById('view-offsite'),
  ready:    document.getElementById('view-ready'),
  scanning: document.getElementById('view-scanning'),
  done:     document.getElementById('view-done'),
};

const el = {
  btnOpenSuno:     document.getElementById('btn-open-suno'),
  btnStartScan:    document.getElementById('btn-start-scan'),
  readyResume:     document.getElementById('ready-resume'),
  resumeCount:     document.getElementById('resume-count'),
  btnResumeExport: document.getElementById('btn-resume-export'),
  btnClearScan:    document.getElementById('btn-clear-scan'),
  scanLabel:       document.getElementById('scan-label'),
  scanCount:       document.getElementById('scan-count'),
  scanLog:         document.getElementById('scan-log'),
  btnPause:        document.getElementById('btn-pause'),
  btnStopExport:   document.getElementById('btn-stop-export'),
  doneCount:       document.getElementById('done-count'),
  doneDateRange:   document.getElementById('done-date-range'),
  zipProgressArea: document.getElementById('zip-progress-area'),
  zipProgressBar:  document.getElementById('zip-progress-bar'),
  zipStatusText:   document.getElementById('zip-status-text'),
  btnDownloadZip:  document.getElementById('btn-download-zip'),
  btnDownloadJson: document.getElementById('btn-download-json'),
  btnScanAgain:    document.getElementById('btn-scan-again'),
};

// ── Helpers ───────────────────────────────────────────────────────────────
function showView(name) {
  state = name;
  Object.entries(views).forEach(([k, v]) => v.classList.toggle('hidden', k !== name));
}

function appendLog(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = 'log-entry' + (type !== 'info' ? ' ' + type : '');
  div.textContent = '> ' + msg;
  el.scanLog.prepend(div);
  while (el.scanLog.children.length > 60) el.scanLog.removeChild(el.scanLog.lastChild);
}

function formatDateRange(songs) {
  const dates = songs.filter(s => s.created_at).map(s => new Date(s.created_at)).filter(d => !isNaN(d));
  if (!dates.length) return '';
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  const fmt = d => d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  return fmt(min) === fmt(max) ? `All from ${fmt(min)}` : `Spanning ${fmt(min)} – ${fmt(max)}`;
}

async function msgContent(msg) {
  if (!activeTabId) return;
  return chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
}

async function msgBg(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Poll song count while scanning ────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    const resp = await msgBg({ type: 'GET_SONGS' });
    const n = resp?.songs?.length ?? 0;
    const current = parseInt(el.scanCount.textContent, 10) || 0;
    if (n > current) {
      appendLog(`+ ${n - current} songs (${n} total)`, 'success');
      el.scanCount.textContent = n;
    }
  }, 1000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ── Scan lifecycle ────────────────────────────────────────────────────────
async function startScan() {
  // Additive: existing captures are kept, so multiple pages/playlists can be
  // combined into one export. Clearing is explicit via the Clear button.
  const resp = await msgBg({ type: 'GET_SONGS' });
  el.scanLog.innerHTML = '';
  el.scanCount.textContent = String(resp?.songs?.length ?? 0);
  el.scanLabel.textContent = 'Loading…';
  isPaused = false;
  el.btnPause.textContent = 'Pause';
  showView('scanning');

  // Refresh the CURRENT page (never navigate away) so document_start fires
  // and the fetch interceptor catches every API call from the very first
  // request. Falls back to /me only if we somehow have no suno tab.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetUrl = isSunoPage(tab?.url) ? tab.url : 'https://suno.com/me';

  appendLog('Loading page…');
  waitingForLibraryLoad = true;
  if (activeTabId) {
    chrome.tabs.update(activeTabId, { url: targetUrl });
  } else {
    const newTab = await chrome.tabs.create({ url: targetUrl });
    activeTabId = newTab.id;
  }
}

async function beginScroll() {
  appendLog('Starting auto-scroll…', 'success');
  await msgContent({ type: 'START_SCROLL' });
  startPolling();
}

async function stopAndShowDone() {
  waitingForLibraryLoad = false;
  stopPolling();
  if (scrollCompleteTimer) { clearTimeout(scrollCompleteTimer); scrollCompleteTimer = null; }
  await msgContent({ type: 'STOP_SCROLL' });
  const resp = await msgBg({ type: 'GET_SONGS' });
  const songs = resp?.songs ?? [];
  el.doneCount.textContent = songs.length;
  el.doneDateRange.textContent = formatDateRange(songs);
  el.zipProgressArea.classList.add('hidden');
  el.btnDownloadZip.disabled = false;
  el.btnDownloadZip.textContent = 'Download ZIP';
  showView('done');
}

// ── ZIP download ──────────────────────────────────────────────────────────
async function startZipDownload() {
  el.btnDownloadZip.disabled = true;
  el.btnDownloadZip.textContent = 'Preparing…';
  el.zipProgressArea.classList.remove('hidden');
  el.zipProgressBar.style.width = '0%';
  el.zipProgressBar.classList.add('active');
  el.zipStatusText.textContent = 'Fetching files…';

  const resp = await msgBg({ type: 'EXPORT_ZIP' });
  if (resp?.error) {
    el.zipProgressBar.classList.remove('active');
    el.zipStatusText.textContent = 'Error: ' + resp.error;
    el.btnDownloadZip.disabled = false;
    el.btnDownloadZip.textContent = 'Download ZIP';
  }
}

// ── Metadata-only download ────────────────────────────────────────────────
async function startJsonDownload() {
  el.btnDownloadJson.disabled = true;
  el.zipProgressArea.classList.remove('hidden');
  el.zipProgressBar.style.width = '50%';
  el.zipStatusText.textContent = 'Preparing metadata…';

  const resp = await msgBg({ type: 'EXPORT_METADATA' });
  if (resp?.error) {
    el.zipStatusText.textContent = 'Error: ' + resp.error;
    el.btnDownloadJson.disabled = false;
  }
}

// ── Background message listener ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SONGS_UPDATED') {
    if (state === 'scanning') {
      el.scanCount.textContent = msg.count;
    } else if (state === 'ready') {
      // Passive capture while browsing — keep the ready view's count live
      el.resumeCount.textContent = msg.count;
      el.readyResume.classList.toggle('hidden', !(msg.count > 0));
    }
  }

  if (msg.type === 'SCROLL_COMPLETE' && state === 'scanning') {
    appendLog('Reached bottom — finalizing…', 'success');
    el.scanLabel.textContent = 'Finishing…';
    if (scrollCompleteTimer) clearTimeout(scrollCompleteTimer);
    scrollCompleteTimer = setTimeout(stopAndShowDone, 3000);
  }

  if (msg.type === 'ZIP_PROGRESS' && state === 'done') {
    const pct = Math.min(100, msg.percent ?? 0);
    el.zipProgressBar.style.width = pct + '%';
    el.zipStatusText.textContent = msg.label
      ? msg.label
      : msg.total
        ? `Fetching files… ${msg.current ?? 0} / ${msg.total}`
        : `Building ZIP… ${pct}%`;
  }

  if (msg.type === 'ZIP_DOWNLOAD_STARTED') {
    if (msg.final === false) {
      // Intermediate part of a chunked export — keep the progress UI running
      el.zipStatusText.textContent = `Part ${msg.part} saved — continuing…`;
    } else {
      el.zipProgressBar.style.width = '100%';
      el.zipProgressBar.classList.remove('active');
      el.zipStatusText.textContent = msg.part > 1
        ? `Download complete — ${msg.part} ZIP parts saved!`
        : 'Download started!';
      el.btnDownloadZip.textContent = 'Download ZIP';
      el.btnDownloadZip.disabled = false;
      el.btnDownloadJson.disabled = false;
    }
  }

  if (msg.type === 'ZIP_ERROR') {
    el.zipProgressBar.classList.remove('active');
    el.zipStatusText.textContent = 'Error: ' + (msg.message || 'unknown error');
    el.btnDownloadZip.disabled = false;
    el.btnDownloadZip.textContent = 'Retry Download';
    el.btnDownloadJson.disabled = false;
  }
});

// ── Tab listeners ─────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== activeTabId || changeInfo.status !== 'complete') return;

  if (waitingForLibraryLoad && isSunoPage(tab.url)) {
    waitingForLibraryLoad = false;
    beginScroll();
    return;
  }

  if (state !== 'scanning') init();
});

chrome.tabs.onActivated.addListener(() => {
  if (state === 'scanning') return;
  init();
});

// ── Button wiring ─────────────────────────────────────────────────────────
el.btnOpenSuno.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://suno.com/me' });
});

el.btnStartScan.addEventListener('click', startScan);

el.btnResumeExport.addEventListener('click', async () => {
  const resp = await msgBg({ type: 'GET_SONGS' });
  const songs = resp?.songs ?? [];
  el.doneCount.textContent = songs.length;
  el.doneDateRange.textContent = formatDateRange(songs);
  el.zipProgressArea.classList.add('hidden');
  el.btnDownloadZip.disabled = false;
  el.btnDownloadZip.textContent = 'Download ZIP';
  showView('done');
});

el.btnClearScan.addEventListener('click', async () => {
  await msgBg({ type: 'CLEAR_SONGS' });
  el.readyResume.classList.add('hidden');
});

el.btnPause.addEventListener('click', async () => {
  if (isPaused) {
    isPaused = false;
    el.btnPause.textContent = 'Pause';
    el.scanLabel.textContent = 'Scrolling…';
    await msgContent({ type: 'START_SCROLL' });
    startPolling();
    appendLog('Resumed.', 'success');
  } else {
    isPaused = true;
    el.btnPause.textContent = 'Resume';
    el.scanLabel.textContent = 'Paused';
    await msgContent({ type: 'STOP_SCROLL' });
    stopPolling();
    appendLog('Paused.');
  }
});

el.btnStopExport.addEventListener('click', stopAndShowDone);
el.btnDownloadZip.addEventListener('click', startZipDownload);
el.btnDownloadJson.addEventListener('click', startJsonDownload);

el.btnScanAgain.addEventListener('click', () => {
  // Back to ready without clearing — browse/scan more pages, then export
  // everything together. Clearing is explicit via the Clear button.
  init();
});

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showView('offsite'); return; }

  activeTabId = tab.id;
  if (!isSunoPage(tab.url)) { showView('offsite'); return; }

  const resp = await msgBg({ type: 'GET_SONGS' });
  const existingCount = resp?.songs?.length ?? 0;

  showView('ready');

  if (existingCount > 0) {
    el.readyResume.classList.remove('hidden');
    el.resumeCount.textContent = existingCount;
  } else {
    el.readyResume.classList.add('hidden');
  }
}

// Version + build stamp — always visible so you can tell which build is loaded.
// build-info.js is generated by build.js; missing (e.g. loading src/ directly) → "dev".
document.getElementById('build-info').textContent =
  `SAM v${chrome.runtime.getManifest().version} · build ${window.__AM_BUILD__ || 'dev'}`;

init();
