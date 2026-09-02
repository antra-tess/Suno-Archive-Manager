// SAM — Firefox MV2 Persistent Background Page
// JSZip and ID3Writer are loaded via manifest background scripts array.

'use strict';

let allSongs = [];

// Latest full API request context (origin + headers incl. Bearer, Device-Id,
// Browser-Token…), snooped by the content script. The token is short-lived —
// the page keeps renewing it while open, and we always keep the newest.
let apiAuth = null;

// ── Download URL resolution ────────────────────────────────────────────────
// Suno moved audio delivery to short-lived / streaming URLs (audiopipe,
// signed media_urls). The reliable path is the site's own resolver:
//   GET /api/download/clip/{id}?format=mp3  →  { status, download_url }
// Bare requests get 403 → /api/forbidden — the WAF wants the site's full
// header set, so replay the snapshot captured by the content script.
// May answer status:"processing" until the file is ready; poll briefly.
// Fall back to the captured audio_url when resolution fails.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// fetch with a hard timeout — audiopipe streaming URLs can otherwise hang
// arrayBuffer() forever and stall the whole export.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ctrl.signal });
    const buf = await r.arrayBuffer();
    return { ok: r.ok, status: r.status, buffer: buf };
  } finally {
    clearTimeout(timer);
  }
}

// Headers describing the original request's body/connection — never replay.
const SKIP_HEADERS = /^(content-length|content-type|host|connection|accept-encoding)$/i;

function replayHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).forEach(k => {
    if (!SKIP_HEADERS.test(k)) out[k] = headers[k];
  });
  return out;
}

// Circuit breaker: after 3 songs in a row fail to resolve, stop trying and
// fall back to captured URLs for the rest — otherwise a dead resolver (e.g.
// Suno tab closed, token can't renew) stalls every song for many seconds.
let resolverFailStreak = 0;

async function resolveDownloadUrl(songId) {
  if (resolverFailStreak >= 3) return '';
  const url = await resolveDownloadUrlInner(songId);
  resolverFailStreak = url ? 0 : resolverFailStreak + 1;
  return url;
}

async function resolveDownloadUrlInner(songId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!apiAuth || !apiAuth.origin) return '';
    let data;
    try {
      const r = await fetch(`${apiAuth.origin}/api/download/clip/${songId}?format=mp3`, {
        headers: replayHeaders(apiAuth.headers),
        credentials: 'include',
      });
      if (r.status === 403 || r.status === 401 || r.status === 429) {
        // Stale token or rate-limited — wait briefly and retry.
        await sleep(2000);
        continue;
      }
      if (!r.ok) return '';
      data = await r.json();
    } catch (e) {
      return '';
    }
    if (data && data.status === 'processing') { await sleep(1500); continue; }
    if (data && data.status !== 'error' && data.download_url) return data.download_url;
    return '';
  }
  return '';
}

function notifyPopup(msg) {
  browser.runtime.sendMessage(msg).catch(() => {});
}

// ── Toolbar badge = captured song count ───────────────────────────────────
function updateBadge() {
  browser.browserAction.setBadgeText({ text: allSongs.length > 0 ? String(allSongs.length) : '' });
  browser.browserAction.setBadgeBackgroundColor({ color: '#7c3aed' });
}

// Toolbar icon opens the sidebar (must be called from a user-input handler)
browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.open().catch(() => {});
});

function sanitizeFilename(name) {
  return (name || 'untitled').replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function parseTitle(raw) {
  const idx = raw.indexOf(' - ');
  if (idx > 0) return { artist: raw.slice(0, idx).trim(), title: raw.slice(idx + 3).trim() };
  return { artist: null, title: raw };
}

function getExtension(url) {
  const path = (url || '').split('?')[0];
  const m = path.match(/\.(m4a|mp3|wav|ogg)$/i);
  return m ? m[1].toLowerCase() : 'mp3';
}

// Legacy permanent CDN links (cdn1.suno.ai/….mp3) — directly downloadable
// with no auth and no expiry, so the resolver round-trip can be skipped.
function isStableCdnUrl(u) {
  try {
    const p = new URL(u || '');
    return /^cdn\d*\.suno\.ai$/.test(p.hostname) &&
           /\.(mp3|m4a|wav|ogg)$/i.test(p.pathname) &&
           !p.search; // signed variants carry query params — treat as expiring
  } catch (e) {
    return false;
  }
}

// Audiopipe URLs are streaming endpoints — they never serve a complete file,
// so using one as a download fallback just burns the full fetch timeout.
function isAudiopipeUrl(u) {
  try {
    return /^audiopipe/.test(new URL(u || '').hostname);
  } catch (e) {
    return false;
  }
}

function detectCoverMime(buffer) {
  const b = new Uint8Array(buffer, 0, 4);
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  return 'image/jpeg';
}

// Song metadata as written to metadata.json / the JSON-only export.
function metadataEntry(song) {
  return {
    id:           song.id,
    title:        song.title,
    display_name: song.display_name || '',
    handle:       song.handle ?? null,
    user_id:      song.user_id ?? null,
    avatar_url:   song.avatar_url ?? null,
    tags:         song.tags || '',
    prompt:       song.prompt || '',
    created_at:   song.created_at || '',
    model_name:    song.model_name ?? null,
    model_version: song.model_version ?? null,
    play_count:   song.play_count ?? null,
    upvote_count: song.upvote_count ?? null,
    is_liked:     song.is_liked ?? null,
    is_disliked:  song.is_disliked ?? null,
    is_public:    song.is_public ?? null,
    is_cover:       song.cover_clip_id != null,
    cover_clip_id:  song.cover_clip_id ?? null,
    is_part:        Array.isArray(song.history) && song.history.length > 0,
    history:        song.history ?? null,
    concat_history: song.concat_history ?? null,
    playlists:    song.playlists || [],
    audio_url:    song.audio_url,
    image_url:    song.image_url || '',
  };
}

// Metadata-only export: no audio/cover fetching, single small JSON file.
async function exportMetadata(songs) {
  const dateStr = new Date().toISOString().split('T')[0];
  const json = JSON.stringify(songs.map(metadataEntry), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  await browser.downloads.download({ url, filename: `SAM_metadata_${dateStr}.json`, saveAs: false });
  notifyPopup({ type: 'ZIP_DOWNLOAD_STARTED', part: 1, final: true });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Cap each ZIP part at ~500MB of fetched content — a single archive of the
// whole library blows past JSZip's memory ceiling (~2GB) on large libraries.
const CHUNK_BYTES = 500 * 1024 * 1024;

async function assembleZip(songs) {
  const dateStr = new Date().toISOString().split('T')[0];
  const folderName = `SAM_${dateStr}`;
  const total = songs.length;

  let part = 1;
  let zip, root, audioFolder, coversFolder, metadata, partBytes;

  function newPart() {
    zip          = new JSZip();
    root         = zip.folder(folderName);
    audioFolder  = root.folder('audio');
    coversFolder = root.folder('covers');
    metadata     = [];
    partBytes    = 0;
  }

  // Each part carries a metadata.json for its own songs → self-contained parts.
  async function flushPart(isFinal, fetchPercent) {
    root.file('metadata.json', JSON.stringify(metadata, null, 2));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
      notifyPopup({
        type: 'ZIP_PROGRESS',
        percent: isFinal ? 90 + Math.round(meta.percent * 0.1) : fetchPercent,
        label: `Building ZIP part ${part}… ${Math.round(meta.percent)}%`,
      });
    });

    const suffix = (isFinal && part === 1) ? '' : `_part${part}`;
    const url    = URL.createObjectURL(blob);
    await browser.downloads.download({ url, filename: `SAM_${dateStr}${suffix}.zip`, saveAs: false });
    notifyPopup({ type: 'ZIP_DOWNLOAD_STARTED', part, final: isFinal });
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    part++;
    newPart(); // release the finished part's buffers
  }

  newPart();

  // Fetch one song's assets (cover + audio) — pure fetching, no zip mutation,
  // so several songs can safely be in flight at once. Legacy songs with
  // permanent CDN links skip the resolver round-trip entirely.
  async function fetchSongAssets(song) {
    const safeName = sanitizeFilename(song.title) + '_' + song.id.slice(0, 8);
    const out = {
      song, safeName,
      coverFilename: `${safeName}.jpg`,
      coverBuffer: null,
      coverMime: 'image/jpeg',
      audioBuffer: null,
      ext: getExtension(song.audio_url),
    };

    const coverP = (async () => {
      if (!song.image_url) return;
      try {
        const r = await fetchWithTimeout(song.image_url, {}, 30000);
        if (r.ok) {
          out.coverBuffer = r.buffer;
          out.coverMime   = detectCoverMime(r.buffer);
        }
      } catch (e) {
        console.warn('[AM] Cover fetch failed:', song.id, e.message);
      }
    })();

    const audioP = (async () => {
      // 1. Stable CDN link → direct download, skip the resolver.
      if (isStableCdnUrl(song.audio_url)) {
        try {
          const r = await fetchWithTimeout(song.audio_url, {}, 120000);
          if (r.ok) { out.audioBuffer = r.buffer; out.source = 'cdn'; return; }
        } catch (e) { /* fall through to resolver */ }
      }
      // 2. Resolver → fresh signed URL. Captured audio_url is a last resort,
      //    but NEVER an audiopipe URL — those are streaming endpoints that
      //    just burn the whole fetch timeout without yielding a file.
      const resolvedUrl = song.id ? await resolveDownloadUrl(song.id) : '';
      const audioUrl = resolvedUrl ||
        ((isStableCdnUrl(song.audio_url) || isAudiopipeUrl(song.audio_url))
          ? '' : song.audio_url);
      if (!audioUrl) { out.source = 'no-url'; return; }
      if (resolvedUrl) out.ext = getExtension(resolvedUrl);
      try {
        const r = await fetchWithTimeout(audioUrl, {}, 120000);
        if (r.ok) {
          out.audioBuffer = r.buffer;
          out.source = resolvedUrl ? 'resolved' : 'fallback';
        } else {
          out.source = `http-${r.status}`;
        }
      } catch (e) {
        out.source = 'fetch-error';
        console.warn('[AM] Audio fetch failed:', song.id, e.message);
      }
    })();

    await Promise.all([coverP, audioP]);
    out.audioFilename = `${safeName}.${out.ext}`;

    // ID3 tags for MP3 only — after both fetches so the tag embeds the cover.
    if (out.audioBuffer && out.ext === 'mp3') {
      try {
        const { artist, title } = parseTitle(song.title);
        const resolvedArtist = artist || song.display_name || null;

        const tags = {
          title:       title,
          artist:      resolvedArtist,
          albumArtist: song.display_name || resolvedArtist,
          album:       'SAM - Suno Archive Manager',
          year:        song.created_at ? new Date(song.created_at).getFullYear() : null,
          cover:       out.coverBuffer || null,
          coverMime:   out.coverMime,
        };
        if (song.tags)   tags.genre   = song.tags.split(',')[0].trim();
        if (song.prompt) tags.comment = song.prompt.slice(0, 500);

        out.audioBuffer = ID3Writer.write(out.audioBuffer, tags);
      } catch (e) {
        console.warn('[AM] ID3 tagging failed:', song.id, e.message);
      }
    }
    return out;
  }

  // Fetch several songs concurrently — resolver round-trips (which can poll
  // a "processing" state for seconds) make serial exports crawl.
  const BATCH_SIZE = 5;

  // Per-song completion telemetry: counter ticks as songs actually finish,
  // and failures are surfaced in the label instead of silently producing an
  // audio-less ZIP.
  let done = 0;
  let failed = 0;

  for (let i = 0; i < songs.length; i += BATCH_SIZE) {
    const batch = songs.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map(s =>
      fetchSongAssets(s)
        .catch(e => {
          console.warn('[AM] Song fetch failed:', s.id, e && e.message);
          return null;
        })
        .then(res => {
          done++;
          const src = res ? (res.source || 'no-audio') : 'crashed';
          const ok = !!(res && res.audioBuffer);
          if (!ok) failed++;
          console.log(`[AM] ${done}/${total} ${ok ? 'ok' : 'FAIL'} (${src})`,
            s.id, s.title);
          notifyPopup({
            type: 'ZIP_PROGRESS',
            percent: Math.round((done / total) * 90),
            current: done, total,
            label: `Fetching files… ${done} / ${total}` +
                   (failed ? ` — ${failed} failed` : ''),
          });
          return res;
        })
    ));

    for (const res of results) {
      if (!res) continue;
      if (res.coverBuffer) {
        coversFolder.file(res.coverFilename, res.coverBuffer);
        partBytes += res.coverBuffer.byteLength;
      }
      if (res.audioBuffer) {
        audioFolder.file(res.audioFilename, res.audioBuffer);
        partBytes += res.audioBuffer.byteLength;
      }
      metadata.push({
        ...metadataEntry(res.song),
        audio_file: res.audioBuffer ? `audio/${res.audioFilename}` : null,
        audio_error: res.audioBuffer ? undefined : (res.source || 'no-audio'),
        cover_file: res.coverBuffer ? `covers/${res.coverFilename}` : null,
      });
    }

    if (partBytes >= CHUNK_BYTES && i + BATCH_SIZE < songs.length) {
      await flushPart(false, Math.round((i / total) * 90));
    }
  }

  await flushPart(true, 90);
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ADD_SONGS') {
    const byId = new Map(allSongs.map(s => [s.id, s]));
    for (const s of msg.songs) {
      const cur = byId.get(s.id);
      if (!cur) {
        byId.set(s.id, s);
        allSongs.push(s);
      } else if (Array.isArray(s.playlists) && s.playlists.length) {
        // Known song re-seen inside a playlist — merge the attribution
        cur.playlists = cur.playlists || [];
        for (const p of s.playlists) {
          if (!cur.playlists.some(q => q.id === p.id)) cur.playlists.push(p);
        }
      }
    }
    notifyPopup({ type: 'SONGS_UPDATED', count: allSongs.length });
    updateBadge();
    return Promise.resolve({ ok: true });

  } else if (msg.type === 'AUTH_TOKEN') {
    if (msg.origin) apiAuth = { origin: msg.origin, headers: msg.headers || {} };
    return Promise.resolve({ ok: true });

  } else if (msg.type === 'GET_SONGS') {
    return Promise.resolve({ songs: allSongs });

  } else if (msg.type === 'CLEAR_SONGS') {
    allSongs = [];
    updateBadge();
    return Promise.resolve({ ok: true });

  } else if (msg.type === 'SCROLL_COMPLETE') {
    notifyPopup({ type: 'SCROLL_COMPLETE' });
    return Promise.resolve({ ok: true });

  } else if (msg.type === 'EXPORT_ZIP') {
    if (allSongs.length === 0) return Promise.resolve({ error: 'No songs to export' });
    assembleZip(allSongs).catch(err => {
      console.error('[AM BG] ZIP error:', err);
      notifyPopup({ type: 'ZIP_ERROR', message: String(err) });
    });
    return Promise.resolve({ ok: true });

  } else if (msg.type === 'EXPORT_METADATA') {
    if (allSongs.length === 0) return Promise.resolve({ error: 'No songs to export' });
    exportMetadata(allSongs).catch(err => {
      console.error('[AM BG] Metadata export error:', err);
      notifyPopup({ type: 'ZIP_ERROR', message: String(err) });
    });
    return Promise.resolve({ ok: true });
  }
});
