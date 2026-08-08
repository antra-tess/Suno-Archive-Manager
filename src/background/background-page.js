// SAM — Firefox MV2 Persistent Background Page
// JSZip and ID3Writer are loaded via manifest background scripts array.

'use strict';

let allSongs = [];

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

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    notifyPopup({
      type: 'ZIP_PROGRESS',
      percent: Math.round((i / total) * 90),
      current: i, total,
      label: `Fetching files… ${i} / ${total}`,
    });

    const ext      = getExtension(song.audio_url);
    const safeName = sanitizeFilename(song.title) + '_' + song.id.slice(0, 8);
    const audioFilename = `${safeName}.${ext}`;
    const coverFilename = `${safeName}.jpg`;

    // ── Cover ────────────────────────────────────────────────────────────
    let coverBuffer = null;
    let coverMime   = 'image/jpeg';
    if (song.image_url) {
      try {
        const r = await fetch(song.image_url);
        if (r.ok) {
          coverBuffer = await r.arrayBuffer();
          coverMime   = detectCoverMime(coverBuffer);
          coversFolder.file(coverFilename, coverBuffer);
          partBytes += coverBuffer.byteLength;
        }
      } catch (e) {
        console.warn('[AM] Cover fetch failed:', song.id, e.message);
      }
    }

    // ── Audio ────────────────────────────────────────────────────────────
    if (song.audio_url) {
      try {
        const r = await fetch(song.audio_url);
        if (r.ok) {
          let audioBuffer = await r.arrayBuffer();

          if (ext === 'mp3') {
            try {
              const { artist, title } = parseTitle(song.title);
              const resolvedArtist = artist || song.display_name || null;

              const tags = {
                title:       title,
                artist:      resolvedArtist,
                albumArtist: song.display_name || resolvedArtist,
                album:       'SAM - Suno Archive Manager',
                year:        song.created_at ? new Date(song.created_at).getFullYear() : null,
                cover:       coverBuffer || null,
                coverMime,
              };
              if (song.tags)   tags.genre   = song.tags.split(',')[0].trim();
              if (song.prompt) tags.comment = song.prompt.slice(0, 500);

              audioBuffer = ID3Writer.write(audioBuffer, tags);
            } catch (e) {
              console.warn('[AM] ID3 tagging failed:', song.id, e.message);
            }
          }

          audioFolder.file(audioFilename, audioBuffer);
          partBytes += audioBuffer.byteLength;
        }
      } catch (e) {
        console.warn('[AM] Audio fetch failed:', song.id, e.message);
      }
    }

    metadata.push({
      ...metadataEntry(song),
      audio_file: `audio/${audioFilename}`,
      cover_file: song.image_url ? `covers/${coverFilename}` : null,
    });

    if (partBytes >= CHUNK_BYTES && i < songs.length - 1) {
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
