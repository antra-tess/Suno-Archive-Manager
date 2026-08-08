// SAM — Chrome Offscreen Document
// Assembles the ZIP with ID3-tagged MP3s and embedded cover art.

'use strict';

// ID3Writer and JSZip are loaded via offscreen.html script tags

function sanitizeFilename(name) {
  return (name || 'untitled').replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Parse "Artist - Track Name" or return title as-is
function parseTitle(raw) {
  const idx = raw.indexOf(' - ');
  if (idx > 0) {
    return {
      artist: raw.slice(0, idx).trim(),
      title:  raw.slice(idx + 3).trim(),
    };
  }
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
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}

// Song metadata as written to metadata.json / the JSON-only export.
// Shared by both export paths so the two can't drift apart.
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
    is_public:    song.is_public ?? null,
    playlists:    song.playlists || [],
    audio_url:    song.audio_url,
    image_url:    song.image_url || '',
  };
}

// Metadata-only export: no audio/cover fetching, single small JSON file.
function exportMetadata(songs) {
  const dateStr = new Date().toISOString().split('T')[0];
  const json = JSON.stringify(songs.map(metadataEntry), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  chrome.runtime.sendMessage({
    type: 'ZIP_READY', url, filename: `SAM_metadata_${dateStr}.json`, part: 1, final: true,
  });
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

// Cap each ZIP part at ~500MB of fetched content. Building everything into a
// single archive means JSZip holds the whole library in memory and dies with a
// RangeError ("invalid array length") somewhere past ~2GB. Parts keep peak
// memory bounded regardless of library size.
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

  // Generate the current part and hand it to the service worker for download.
  // Each part carries a metadata.json for its own songs, so every part is
  // self-contained even if a later part fails.
  async function flushPart(isFinal, fetchPercent) {
    root.file('metadata.json', JSON.stringify(metadata, null, 2));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
      chrome.runtime.sendMessage({
        type: 'ZIP_PROGRESS',
        percent: isFinal ? 90 + Math.round(meta.percent * 0.1) : fetchPercent,
        label: `Building ZIP part ${part}… ${Math.round(meta.percent)}%`,
      });
    });

    // A single-part export keeps the plain name; parts only appear when the
    // size cap was actually hit.
    const suffix   = (isFinal && part === 1) ? '' : `_part${part}`;
    const url      = URL.createObjectURL(blob);
    const filename = `SAM_${dateStr}${suffix}.zip`;
    chrome.runtime.sendMessage({ type: 'ZIP_READY', url, filename, part, final: isFinal });
    setTimeout(() => URL.revokeObjectURL(url), 120000);

    part++;
    newPart(); // drop references so the finished part's buffers can be GC'd
  }

  newPart();

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    chrome.runtime.sendMessage({
      type: 'ZIP_PROGRESS',
      percent: Math.round((i / total) * 90),
      current: i, total,
      label: `Fetching files… ${i} / ${total}`,
    });

    const ext      = getExtension(song.audio_url);
    const safeName = sanitizeFilename(song.title) + '_' + song.id.slice(0, 8);
    const audioFilename = `${safeName}.${ext}`;
    const coverFilename = `${safeName}.jpg`;

    // ── Fetch cover ──────────────────────────────────────────────────────
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

    // ── Fetch audio ──────────────────────────────────────────────────────
    if (song.audio_url) {
      try {
        const r = await fetch(song.audio_url);
        if (r.ok) {
          let audioBuffer = await r.arrayBuffer();

          // Embed ID3 tags for MP3 only (M4A uses a different atom format)
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

              if (song.tags) {
                tags.genre = song.tags.split(',')[0].trim();
              }
              if (song.prompt) {
                // Truncate long prompts to keep the tag size sane
                tags.comment = song.prompt.slice(0, 500);
              }

              audioBuffer = ID3Writer.write(audioBuffer, tags);
            } catch (e) {
              console.warn('[AM] ID3 tagging failed:', song.id, e.message);
              // Fall through — still add the untagged audio
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ASSEMBLE_ZIP') {
    assembleZip(msg.songs).catch(err => {
      console.error('[AM Offscreen] ZIP error:', err);
      chrome.runtime.sendMessage({ type: 'ZIP_ERROR', message: String(err) });
    });
  } else if (msg.type === 'ASSEMBLE_METADATA') {
    try {
      exportMetadata(msg.songs);
    } catch (err) {
      console.error('[AM Offscreen] Metadata export error:', err);
      chrome.runtime.sendMessage({ type: 'ZIP_ERROR', message: String(err) });
    }
  }
});
