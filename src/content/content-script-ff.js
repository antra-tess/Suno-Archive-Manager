// SAM — Firefox Content Script (MV2)
// Firefox content scripts run in isolated scope, so we inject a <script> tag
// to patch window.fetch in the page's MAIN world, then bridge via custom events.

'use strict';

// ── Inject page-world script via <script> tag ─────────────────────────────
const pageScript = `
(function() {
  if (window.__archiveMasterAttached) return;
  window.__archiveMasterAttached = true;

  function sanitizeFilename(name) {
    return (name || 'untitled').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  }

  function findSongs(obj) {
    let found = [];
    if (!obj || typeof obj !== 'object') return found;
    if (obj.id && (obj.audio_url || (obj.metadata && obj.metadata.audio_url))) return [obj];
    if (Array.isArray(obj)) {
      obj.forEach(function(i) { found = found.concat(findSongs(i)); });
    } else {
      Object.keys(obj).forEach(function(k) {
        if (k !== 'metadata' && typeof obj[k] === 'object') {
          found = found.concat(findSongs(obj[k]));
        }
      });
    }
    return found;
  }

  // Find playlist/project containers so songs can be attributed to their
  // collection (playlist_clips = playlists, project_clips = projects)
  function findPlaylists(obj, out) {
    out = out || [];
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { obj.forEach(function(i) { findPlaylists(i, out); }); return out; }
    var clips = Array.isArray(obj.playlist_clips) ? obj.playlist_clips
              : Array.isArray(obj.project_clips)  ? obj.project_clips
              : null;
    if (obj.id && clips) {
      out.push({ id: obj.id, name: obj.name || obj.title || '', clips: clips });
    }
    Object.keys(obj).forEach(function(k) {
      if (k !== 'metadata' && typeof obj[k] === 'object') findPlaylists(obj[k], out);
    });
    return out;
  }

  function normalizeSong(raw) {
    var audioUrl = raw.audio_url || (raw.metadata && raw.metadata.audio_url) || '';
    var imageUrl = raw.image_url || raw.image_large_url || (raw.metadata && raw.metadata.image_url) || '';
    return {
      id: raw.id,
      title: raw.title || 'Untitled',
      audio_url: audioUrl,
      image_url: imageUrl,
      tags: (raw.metadata && raw.metadata.tags) || raw.tags || '',
      prompt: (raw.metadata && raw.metadata.prompt) || raw.prompt || '',
      created_at: raw.created_at || '',
      display_name: raw.display_name || raw.user_display_name ||
                    (raw.profiles && raw.profiles.display_name) || raw.handle || '',
      handle:       firstDefined(raw.handle, raw.profiles && raw.profiles.handle),
      user_id:      firstDefined(raw.user_id),
      avatar_url:   firstDefined(raw.avatar_image_url, raw.profiles && raw.profiles.avatar_image_url),
      model_name:    firstDefined(raw.model_name, raw.metadata && raw.metadata.model_name),
      model_version: firstDefined(raw.major_model_version, raw.metadata && raw.metadata.major_model_version),
      play_count:   firstDefined(raw.play_count,   raw.metadata && raw.metadata.play_count,   raw.stats && raw.stats.play_count),
      upvote_count: firstDefined(raw.upvote_count, raw.metadata && raw.metadata.upvote_count, raw.stats && raw.stats.upvote_count),
      is_liked:     firstDefined(raw.is_liked,     raw.reaction && raw.reaction.is_liked),
      is_disliked:  firstDefined(raw.is_disliked,  raw.reaction && raw.reaction.is_disliked),
      is_public:    firstDefined(raw.is_public,    raw.metadata && raw.metadata.is_public),
      cover_clip_id:  firstDefined(raw.metadata && raw.metadata.cover_clip_id, raw.cover_clip_id),
      history:        firstDefined(raw.metadata && raw.metadata.history),
      concat_history: firstDefined(raw.metadata && raw.metadata.concat_history),
    };
  }

  function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return null;
  }

  // Dedup on (song id, playlist id) pairs — a song already sent without
  // playlist context is re-sent when it shows up inside a playlist, so the
  // background can merge the attribution.
  var sentKeys = new Set();

  // Every playlist/project id → name we've ever seen (listings included).
  // Used to attribute container-less feed responses by request context.
  var knownPlaylists = new Map();

  // Capture the true original fetch ONCE. attachInterceptor() is re-run on
  // every SPA navigation; re-reading window.fetch there would wrap our own
  // wrapper again and again, stacking one layer per navigation.
  var trueFetch = window.fetch;

  function attachInterceptor() {
    var originalFetch = trueFetch;
    window.fetch = function() {
      var args = Array.prototype.slice.call(arguments);
      var resource = args[0];
      var init = args[1];
      var url = resource instanceof Request ? resource.url : String(resource);

      if (/(statsig|segment|stratovibe|sentry|rgstr|pixel)/i.test(url)) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }

      // Snapshot the request body BEFORE it's consumed — used to attribute
      // container-less feed responses to the playlist they belong to.
      var reqTextPromise = Promise.resolve('');
      try {
        if (init && typeof init.body === 'string') {
          reqTextPromise = Promise.resolve(init.body);
        } else if (resource instanceof Request && resource.method !== 'GET') {
          reqTextPromise = resource.clone().text().catch(function() { return ''; });
        }
      } catch (e) {}

      return originalFetch.apply(this, args).then(function(response) {
        var clone = response.clone();
        clone.json().then(function(data) {
          // Register every playlist/project container we see (even clipless
          // listings) so ids can be resolved to names later
          var containers = findPlaylists(data);
          containers.forEach(function(pl) {
            if (pl.name || !knownPlaylists.has(pl.id)) knownPlaylists.set(pl.id, pl.name || '');
          });

          var raw = findSongs(data);
          if (raw.length === 0) return;

          // Direct attribution: songs inside a container.
          // /api/project/default is the whole library, not a user collection.
          var isLibraryFeed = /\/api\/project\/default\b/.test(url);
          var playlistOf = new Map();
          (isLibraryFeed ? [] : containers).forEach(function(pl) {
            pl.clips.forEach(function(entry) {
              var clip = entry && (entry.clip || entry);
              if (clip && clip.id) playlistOf.set(clip.id, { id: pl.id, name: pl.name });
            });
          });

          reqTextPromise.then(function(reqText) {
            // Context attribution: container-less feed responses (e.g.
            // /api/unified/feed serving a playlist page)
            var ctxPl = null;
            if (playlistOf.size === 0 && !isLibraryFeed) {
              var hay = url + ' ' + (reqText || '');
              knownPlaylists.forEach(function(pname, pid) {
                if (!ctxPl && pid && hay.indexOf(pid) !== -1) ctxPl = { id: pid, name: pname };
              });
              if (!ctxPl) {
                var m = location.pathname.match(/^\/playlist\/([0-9a-f-]{36})/i);
                if (m && (hay.indexOf(m[1]) !== -1 || /\/api\/unified\/feed/.test(url))) {
                  ctxPl = { id: m[1], name: knownPlaylists.get(m[1]) || '' };
                }
              }
            }

            var newSongs = [];
            raw.forEach(function(r) {
              if (!r.id) return;
              var pl = playlistOf.get(r.id) || ctxPl;
              var key = r.id + '|' + (pl ? pl.id : '');
              if (sentKeys.has(key)) return;
              sentKeys.add(key);
              var song = normalizeSong(r);
              song.playlists = pl ? [pl] : [];
              newSongs.push(song);
            });
            if (newSongs.length > 0) {
              window.dispatchEvent(new CustomEvent('__AM_SONGS__', {
                detail: JSON.stringify(newSongs)
              }));
            }
          });
        }).catch(function() {});
        return response;
      });
    };
  }

  // SPA re-attach
  var originalPushState = history.pushState;
  history.pushState = function() {
    originalPushState.apply(this, arguments);
    attachInterceptor();
  };
  window.addEventListener('popstate', function() { attachInterceptor(); });

  // Listen for scroll commands from content script
  window.addEventListener('__AM_CMD__', function(e) {
    var cmd = e.detail;
    if (cmd === 'START_SCROLL') {
      if (window.__amScrollInterval) clearInterval(window.__amScrollInterval);
      window.__amScrollInterval = setInterval(function() {
        window.scrollTo(0, document.body.scrollHeight);
        var nearBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 100;
        if (nearBottom) {
          window.dispatchEvent(new CustomEvent('__AM_SCROLL_DONE__'));
        }
      }, 2500);
    } else if (cmd === 'STOP_SCROLL') {
      if (window.__amScrollInterval) {
        clearInterval(window.__amScrollInterval);
        window.__amScrollInterval = null;
      }
    }
  });

  attachInterceptor();
})();
`;

const scriptEl = document.createElement('script');
scriptEl.textContent = pageScript;
(document.head || document.documentElement).appendChild(scriptEl);
scriptEl.remove();

// ── Bridge: page events → background ─────────────────────────────────────
window.addEventListener('__AM_SONGS__', (e) => {
  try {
    const songs = JSON.parse(e.detail);
    browser.runtime.sendMessage({ type: 'ADD_SONGS', songs }).catch(() => {});
  } catch (_) {}
});

window.addEventListener('__AM_SCROLL_DONE__', () => {
  browser.runtime.sendMessage({ type: 'SCROLL_COMPLETE' }).catch(() => {});
});

// ── Bridge: background → page ─────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_SCROLL' || msg.type === 'STOP_SCROLL') {
    window.dispatchEvent(new CustomEvent('__AM_CMD__', { detail: msg.type }));
    sendResponse({ ok: true });
  } else if (msg.type === 'PING') {
    sendResponse({ ok: true });
  }
  return true;
});
