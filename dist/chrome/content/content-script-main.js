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

  // Every playlist/project id → name we've ever seen (listings included).
  // Used to attribute container-less feed responses by request context.
  const knownPlaylists = new Map();

  // ── Helpers ──────────────────────────────────────────────────────────────
  // Newer Suno clips may carry a `media_urls` array instead of (or alongside)
  // a plain `audio_url`. Items look like { encoding, delivery, content_type,
  // url } — a falsy `encoding` means unencrypted; prefer progressive delivery
  // (a directly fetchable file, not a streaming pipe).
  function bestMediaUrl(raw) {
    const items = Array.isArray(raw.media_urls) ? raw.media_urls : [];
    const plain = items.filter(i => i && i.url && !i.encoding);
    const prog  = plain.find(i => i.delivery === 'progressive');
    return (prog || plain[0] || {}).url || '';
  }

  function findSongs(obj) {
    let found = [];
    if (!obj || typeof obj !== 'object') return found;
    if (obj.id && (obj.audio_url || obj.metadata?.audio_url ||
        (Array.isArray(obj.media_urls) && obj.media_urls.length))) return [obj];
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

  // Find playlist/project containers so songs can be attributed to the
  // collection they were captured from. Suno uses `playlist_clips` on
  // playlist endpoints and `project_clips` on project endpoints (the newer
  // name for library collections).
  function findPlaylists(obj, out) {
    out = out || [];
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { obj.forEach(i => findPlaylists(i, out)); return out; }
    const clips = Array.isArray(obj.playlist_clips) ? obj.playlist_clips
                : Array.isArray(obj.project_clips)  ? obj.project_clips
                : null;
    if (obj.id && clips) {
      out.push({ id: obj.id, name: obj.name || obj.title || '', clips });
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
      audio_url:    raw.audio_url  || raw.metadata?.audio_url  || bestMediaUrl(raw),
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
      is_disliked:  raw.is_disliked  ?? raw.reaction?.is_disliked  ?? null,
      is_public:    raw.is_public    ?? raw.metadata?.is_public    ?? null,
      cover_clip_id:  raw.metadata?.cover_clip_id ?? raw.cover_clip_id ?? null,
      history:        raw.metadata?.history        ?? null,
      concat_history: raw.metadata?.concat_history ?? null,
    };
  }

  function toExt(msg) {
    window.postMessage({ __am: true, ...msg }, '*');
  }

  // ── Auth capture ─────────────────────────────────────────────────────────
  // Suno's API rejects bare requests (403 → /api/forbidden): besides the
  // short-lived Bearer token it wants Device-Id / Browser-Token etc. Rather
  // than reconstruct that set, snapshot the COMPLETE headers of real outgoing
  // API requests (plus the API origin) and let the export path replay them.
  let lastToken = '';
  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && typeof h.get === 'function') {
      h.forEach((v, k) => { out[k] = v; });               // Headers instance
    } else if (Array.isArray(h)) {
      h.forEach(p => { if (p && p[0]) out[p[0]] = p[1]; });
    } else if (typeof h === 'object') {
      Object.keys(h).forEach(k => { out[k] = h[k]; });
    }
    return out;
  }
  function captureAuth(url, resource, init) {
    try {
      const fromInit = headersToObject(init && init.headers);
      const fromReq  = resource instanceof Request ? headersToObject(resource.headers) : {};
      const headers  = { ...fromReq, ...fromInit };
      const authKey  = Object.keys(headers).find(k => /^authorization$/i.test(k));
      const m = /^Bearer\s+(.+)$/i.exec(authKey ? headers[authKey] : '');
      if (m && m[1] !== lastToken) {
        lastToken = m[1];
        toExt({ type: 'AUTH', origin: new URL(url).origin, headers });
      }
    } catch (e) { /* never break the request */ }
  }

  // Updated whenever new songs arrive — adaptive scroll watches this
  let lastSongArrival = 0;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Fetch interceptor ────────────────────────────────────────────────────
  function attachInterceptor() {
    window.fetch = async function (...args) {
      const [resource, init] = args;
      const url = resource instanceof Request ? resource.url : String(resource);

      if (/(statsig|segment|stratovibe|sentry|rgstr|pixel)/i.test(url)) {
        return new Response('{}', { status: 200 });
      }

      if (/\/api\//.test(url)) captureAuth(url, resource, init);

      // Snapshot the request body BEFORE the request is consumed — needed to
      // attribute container-less feed responses to the playlist they belong to.
      let reqTextPromise = Promise.resolve('');
      try {
        if (init && typeof init.body === 'string') {
          reqTextPromise = Promise.resolve(init.body);
        } else if (resource instanceof Request && resource.method !== 'GET') {
          reqTextPromise = resource.clone().text().catch(() => '');
        }
      } catch (e) { /* opaque body — ignore */ }

      try {
        const response = await trueFetch.apply(this, args);
        response.clone().json().then(async data => {
          // Register every playlist/project container we see — including
          // clipless listings — so ids can be resolved to names later.
          const containers = findPlaylists(data);
          for (const pl of containers) {
            if (pl.name || !knownPlaylists.has(pl.id)) knownPlaylists.set(pl.id, pl.name || '');
          }

          const raw = findSongs(data);
          if (!raw.length) return;

          // Direct attribution: song found inside a playlist/project container.
          // /api/project/default (legacy) and /api/project/feed (current) are
          // the whole library, not a user collection — attributing them would
          // tag every library song with noise.
          const isLibraryFeed = /\/api\/project\/(default\b|feed\b)/.test(url);
          const playlistOf = new Map();
          for (const pl of isLibraryFeed ? [] : containers) {
            for (const entry of pl.clips) {
              const clip = entry && (entry.clip || entry);
              if (clip && clip.id) playlistOf.set(clip.id, { id: pl.id, name: pl.name });
            }
          }

          // Context attribution: songs with no wrapping container (e.g.
          // /api/unified/feed serving a playlist page). Attribute the whole
          // response to a playlist if the REQUEST references a known playlist
          // id, or we're on a /playlist/<uuid> page and this is a feed call.
          let ctxPl = null;
          if (!playlistOf.size && !isLibraryFeed) {
            const reqText = await reqTextPromise;
            const hay = url + ' ' + (reqText || '');
            for (const [pid, pname] of knownPlaylists) {
              if (pid && hay.includes(pid)) { ctxPl = { id: pid, name: pname }; break; }
            }
            if (!ctxPl) {
              const m = location.pathname.match(/^\/playlist\/([0-9a-f-]{36})/i);
              if (m && (hay.includes(m[1]) || /\/api\/unified\/feed/.test(url))) {
                ctxPl = { id: m[1], name: knownPlaylists.get(m[1]) || '' };
              }
            }
          }

          const newSongs = [];
          for (const r of raw) {
            if (!r.id) continue;
            const pl = playlistOf.get(r.id) || ctxPl;
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
