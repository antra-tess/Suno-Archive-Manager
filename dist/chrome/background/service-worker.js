// SAM — Chrome MV3 Service Worker
// State lives in chrome.storage.session (survives SW termination)

'use strict';

// Open the side panel when the toolbar icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});


const SESSION_KEY = 'archiveSongs';

// ── Storage helpers ────────────────────────────────────────────────────────
async function getSongs() {
  const result = await chrome.storage.session.get(SESSION_KEY);
  return result[SESSION_KEY] || [];
}

async function saveSongs(songs) {
  await chrome.storage.session.set({ [SESSION_KEY]: songs });
}

// ── Offscreen document management ─────────────────────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (existing) return;
  // Check via getContexts (MV3 way)
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  }).catch(() => []);
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen/offscreen.html'),
    reasons: ['BLOBS'],
    justification: 'Assemble ZIP from fetched audio and image blobs',
  });
}

// ── Forward message to popup (if open) ────────────────────────────────────
function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Toolbar badge = captured song count ───────────────────────────────────
function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' }).catch(() => {});
}

// Restore badge after service-worker restarts
getSongs().then(songs => updateBadge(songs.length)).catch(() => {});

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'ADD_SONGS') {
        const existing = await getSongs();
        const byId = new Map(existing.map(s => [s.id, s]));
        let changed = false;
        for (const s of msg.songs) {
          const cur = byId.get(s.id);
          if (!cur) {
            byId.set(s.id, s);
            existing.push(s);
            changed = true;
          } else if (Array.isArray(s.playlists) && s.playlists.length) {
            // Known song re-seen inside a playlist — merge the attribution
            cur.playlists = cur.playlists || [];
            for (const p of s.playlists) {
              if (!cur.playlists.some(q => q.id === p.id)) {
                cur.playlists.push(p);
                changed = true;
              }
            }
          }
        }
        if (changed) {
          await saveSongs(existing);
          notifyPopup({ type: 'SONGS_UPDATED', count: existing.length });
          updateBadge(existing.length);
        }
        sendResponse({ ok: true });

      } else if (msg.type === 'GET_SONGS') {
        const songs = await getSongs();
        sendResponse({ songs });

      } else if (msg.type === 'CLEAR_SONGS') {
        await saveSongs([]);
        updateBadge(0);
        sendResponse({ ok: true });

      } else if (msg.type === 'SCROLL_COMPLETE') {
        notifyPopup({ type: 'SCROLL_COMPLETE' });
        sendResponse({ ok: true });

      } else if (msg.type === 'EXPORT_ZIP') {
        const songs = await getSongs();
        if (songs.length === 0) {
          sendResponse({ error: 'No songs to export' });
          return;
        }
        await ensureOffscreen();
        chrome.runtime.sendMessage({ type: 'ASSEMBLE_ZIP', songs });
        sendResponse({ ok: true });

      } else if (msg.type === 'EXPORT_METADATA') {
        const songs = await getSongs();
        if (songs.length === 0) {
          sendResponse({ error: 'No songs to export' });
          return;
        }
        await ensureOffscreen();
        chrome.runtime.sendMessage({ type: 'ASSEMBLE_METADATA', songs }).catch(() => {});
        sendResponse({ ok: true });

      } else if (msg.type === 'ZIP_PROGRESS') {
        notifyPopup(msg);
        sendResponse({ ok: true });

      } else if (msg.type === 'ZIP_READY') {
        // Offscreen created an object URL — trigger download
        await chrome.downloads.download({
          url: msg.url,
          filename: msg.filename,
          saveAs: false,
        });
        notifyPopup({ type: 'ZIP_DOWNLOAD_STARTED', part: msg.part, final: msg.final !== false });
        sendResponse({ ok: true });

      } else if (msg.type === 'ZIP_ERROR') {
        notifyPopup(msg);
        sendResponse({ ok: true });
      }
    } catch (err) {
      console.error('[AM SW]', err);
      sendResponse({ error: String(err) });
    }
  })();
  return true; // keep channel open for async response
});
