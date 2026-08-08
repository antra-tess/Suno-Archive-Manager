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

  // Find playlist containers so songs can be attributed to their playlist
  function findPlaylists(obj, out) {
    out = out || [];
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { obj.forEach(function(i) { findPlaylists(i, out); }); return out; }
    if (obj.id && Array.isArray(obj.playlist_clips)) {
      out.push({ id: obj.id, name: obj.name || obj.title || '', clips: obj.playlist_clips });
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
      is_public:    firstDefined(raw.is_public,    raw.metadata && raw.metadata.is_public),
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

  // Capture the true original fetch ONCE. attachInterceptor() is re-run on
  // every SPA navigation; re-reading window.fetch there would wrap our own
  // wrapper again and again, stacking one layer per navigation.
  var trueFetch = window.fetch;

  function attachInterceptor() {
    var originalFetch = trueFetch;
    window.fetch = function() {
      var args = Array.prototype.slice.call(arguments);
      var resource = args[0];
      var url = resource instanceof Request ? resource.url : String(resource);

      if (/(statsig|segment|stratovibe|sentry|rgstr|pixel)/i.test(url)) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }

      return originalFetch.apply(this, args).then(function(response) {
        var clone = response.clone();
        clone.json().then(function(data) {
          var raw = findSongs(data);
          if (raw.length === 0) return;

          var playlistOf = new Map();
          findPlaylists(data).forEach(function(pl) {
            pl.clips.forEach(function(entry) {
              var clip = entry && (entry.clip || entry);
              if (clip && clip.id) playlistOf.set(clip.id, { id: pl.id, name: pl.name });
            });
          });

          var newSongs = [];
          raw.forEach(function(r) {
            if (!r.id) return;
            var pl = playlistOf.get(r.id) || null;
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
