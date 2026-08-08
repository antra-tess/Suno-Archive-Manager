// SAM — MAIN world content script (Chrome)
// Patches window.fetch to capture songs, drives auto-scroll.

(function () {
  'use strict';

  if (window.__archiveMasterMain) return;
  window.__archiveMasterMain = true;

  // Capture true original fetch ONCE — never re-capture after patching
  // or re-attaching, otherwise wrapping window.fetch again causes infinite recursion.
  const trueFetch = window.fetch;

  // Dedup on (song id, playlist id) pairs — a song already sent without
  // playlist context must be re-sent when it later shows up inside a
  // playlist, so the background can merge the attribution.
  let sentKeys = new Set();

  // ── Helpers ──────────────────────────────────────────────────────────────
  function findSongs(obj) {
    let found = [];
    if (!obj || typeof obj !== 'object') return found;
    if (obj.id && (obj.audio_url || obj.metadata?.audio_url)) return [obj];
    if (Array.isArray(obj)) {
      obj.forEach(i => { found = found.concat(findSongs(i)); });
    } else {
      Object.keys(obj).forEach(k => {
        if (k !== 'metadata' && typeof obj[k] === 'object') {
          found = found.concat(findSongs(obj[k]));
        }
      });
    }
    return found;
  }

  // Find playlist containers (objects wrapping a playlist_clips array) so
  // songs can be attributed to the playlist they were captured from.
  function findPlaylists(obj, out) {
    out = out || [];
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { obj.forEach(i => findPlaylists(i, out)); return out; }
    if (obj.id && Array.isArray(obj.playlist_clips)) {
      out.push({ id: obj.id, name: obj.name || obj.title || '', clips: obj.playlist_clips });
    }
    Object.keys(obj).forEach(k => {
      if (k !== 'metadata' && typeof obj[k] === 'object') findPlaylists(obj[k], out);
    });
    return out;
  }

  function normalizeSong(raw) {
    return {
      id:           raw.id,
      title:        raw.title || 'Untitled',
      audio_url:    raw.audio_url  || raw.metadata?.audio_url  || '',
      image_url:    raw.image_url  || raw.image_large_url || raw.metadata?.image_url || '',
      tags:         raw.metadata?.tags   || raw.tags   || '',
      prompt:       raw.metadata?.prompt || raw.prompt || '',
      created_at:   raw.created_at || '',
      display_name: raw.display_name || raw.user_display_name ||
                    raw.profiles?.display_name || raw.handle || '',
      handle:       raw.handle ?? raw.profiles?.handle ?? null,
      user_id:      raw.user_id ?? null,
      avatar_url:   raw.avatar_image_url ?? raw.profiles?.avatar_image_url ?? null,
      model_name:   raw.model_name ?? raw.metadata?.model_name ?? null,
      model_version: raw.major_model_version ?? raw.metadata?.major_model_version ?? null,
      play_count:   raw.play_count   ?? raw.metadata?.play_count   ?? raw.stats?.play_count   ?? null,
      upvote_count: raw.upvote_count ?? raw.metadata?.upvote_count ?? raw.stats?.upvote_count ?? null,
      is_liked:     raw.is_liked     ?? raw.reaction?.is_liked     ?? null,
      is_public:    raw.is_public    ?? raw.metadata?.is_public    ?? null,
    };
  }

  function toExt(msg) {
    window.postMessage({ __am: true, ...msg }, '*');
  }

  // Updated whenever new songs arrive — adaptive scroll watches this
  let lastSongArrival = 0;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Fetch interceptor ────────────────────────────────────────────────────
  function attachInterceptor() {
    window.fetch = async function (...args) {
      const [resource] = args;
      const url = resource instanceof Request ? resource.url : String(resource);

      if (/(statsig|segment|stratovibe|sentry|rgstr|pixel)/i.test(url)) {
        return new Response('{}', { status: 200 });
      }

      try {
        const response = await trueFetch.apply(this, args);
        response.clone().json().then(data => {
          const raw = findSongs(data);
          if (!raw.length) return;

          // Map song id → playlist it appeared under (if any)
          const playlistOf = new Map();
          for (const pl of findPlaylists(data)) {
            for (const entry of pl.clips) {
              const clip = entry && (entry.clip || entry);
              if (clip && clip.id) playlistOf.set(clip.id, { id: pl.id, name: pl.name });
            }
          }

          const newSongs = [];
          for (const r of raw) {
            if (!r.id) continue;
            const pl = playlistOf.get(r.id) || null;
            const key = r.id + '|' + (pl ? pl.id : '');
            if (sentKeys.has(key)) continue;
            sentKeys.add(key);
            const song = normalizeSong(r);
            song.playlists = pl ? [pl] : [];
            newSongs.push(song);
          }
          if (newSongs.length) {
            lastSongArrival = Date.now();
            toExt({ type: 'SONGS', songs: newSongs });
          }
        }).catch(() => {});
        return response;
      } catch (e) {
        return Promise.reject(e);
      }
    };
  }

  // SPA re-attach — always delegates to trueFetch so no recursion risk
  const origPush = history.pushState;
  history.pushState = function (...args) { origPush.apply(this, args); attachInterceptor(); };
  window.addEventListener('popstate', () => attachInterceptor());

  // ── Scroll ────────────────────────────────────────────────────────────────
  // Scroll as fast as possible — the fetch interceptor captures inbound data
  // passively at whatever rate Suno delivers it. We just need to keep
  // triggering the infinite-scroll loader. Done when no new songs have
  // arrived for IDLE_DONE_MS while sitting at the bottom.

  const SCROLL_INTERVAL_MS = 400;
  const IDLE_DONE_MS       = 5000; // no new songs + at bottom = complete

  let scrollInterval = null;

  function startScroll() {
    if (scrollInterval) return;
    lastSongArrival = Date.now();

    scrollInterval = setInterval(() => {
      window.scrollTo(0, document.body.scrollHeight);

      const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 200;
      const idleSince = Date.now() - lastSongArrival;

      if (atBottom && idleSince >= IDLE_DONE_MS) {
        stopScroll();
        toExt({ type: 'SCROLL_COMPLETE' });
      }
    }, SCROLL_INTERVAL_MS);
  }

  function stopScroll() {
    if (scrollInterval) { clearInterval(scrollInterval); scrollInterval = null; }
  }

  // ── Commands from bridge ─────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__am) return;
    if (e.data.type === 'START_SCROLL') startScroll();
    else if (e.data.type === 'STOP_SCROLL') stopScroll();
  });

  attachInterceptor();
})();
