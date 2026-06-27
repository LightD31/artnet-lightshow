// Runs in the PAGE context (not the isolated content-script world) so it can
// read the Deezer web player's internal state: window.dzPlayer. It samples the
// current song, position, play-state and upcoming queue once a second and
// postMessage()s a snapshot to the content script, which relays it to the
// background worker → the lightshow server.
//
// ⚠️ dzPlayer is undocumented and Deezer changes it. The method/field names
// below are best-effort with fallbacks; if it stops working, see README.md for
// the console recipe to rediscover the current shape.
(function () {
  'use strict';

  const POLL_MS = 1000;

  const coverUrl = (md5) =>
    md5 ? `https://e-cdn-images.dzcdn.net/images/cover/${md5}/264x264-000000-80-0-0.jpg` : null;

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // Map a Deezer "SNG" gateway song object to our track shape. Returns null if
  // it's just an id / lacks the metadata we need.
  function toTrack(s) {
    if (!s || typeof s !== 'object') return null;
    const title = s.SNG_TITLE || s.title;
    const artist = s.ART_NAME || (s.artist && s.artist.name) || (typeof s.artist === 'string' ? s.artist : null);
    if (!title || !artist) return null;
    return {
      trackId: String(s.SNG_ID || s.id || ''),
      isrc: s.ISRC || null,
      title,
      artist,
      album: s.ALB_TITLE || (s.album && s.album.title) || '',
      durationMs: num(s.DURATION || s.duration) * 1000,
      albumArt: coverUrl(s.ALB_PICTURE || (s.album && s.album.md5_image)),
    };
  }

  // Deezer exposes the queue as getTrackList() (full song objects) and the
  // current position as getIndexSong()/getTrackListIndex().
  function readTrackList(p) {
    try {
      const list = typeof p.getTrackList === 'function' ? p.getTrackList() : null;
      if (Array.isArray(list)) return list;
    } catch (_) { /* ignore */ }
    return [];
  }

  function queueIndex(p) {
    for (const fn of ['getIndexSong', 'getTrackListIndex', 'getCurrentIndex', 'getCurrentSongIndex', 'getPosInQueue']) {
      if (typeof p[fn] === 'function') {
        try { const i = p[fn](); if (Number.isInteger(i) && i >= 0) return i; } catch (_) { /* ignore */ }
      }
    }
    return Number.isInteger(p.currentIndex) ? p.currentIndex : -1;
  }

  // Upcoming = tracks after the current index, falling back to getNextSong()
  // (which alone still enables depth-1 prefetch).
  function readUpcoming(p, current) {
    const list = readTrackList(p);
    if (list.length) {
      let idx = queueIndex(p);
      if (idx < 0 && current) {
        idx = list.findIndex((s) => s && String(s.SNG_ID || s.id || '') === current.trackId);
      }
      const rest = idx >= 0 ? list.slice(idx + 1) : list;
      const mapped = rest.map(toTrack).filter(Boolean);
      if (mapped.length) return mapped.slice(0, 10);
    }
    try {
      if (typeof p.getNextSong === 'function') {
        const next = toTrack(p.getNextSong());
        if (next) return [next];
      }
    } catch (_) { /* ignore */ }
    return [];
  }

  function snapshot() {
    const p = window.dzPlayer;
    if (!p) return null;

    const cur = (p.getCurrentSong && p.getCurrentSong()) || p.currentSong;
    const current = toTrack(cur);
    if (!current) return null;

    // getPosition() is seconds in the Deezer player (verify if it drifts).
    const posSec = (p.getPosition && p.getPosition()) || 0;
    current.progressMs = Math.round(num(posSec) * 1000);
    current.isPlaying = p.isPlaying ? !!p.isPlaying() : (p.playing != null ? !!p.playing : true);

    const upcoming = readUpcoming(p, current);

    return { current, upcoming };
  }

  let lastJson = '';
  setInterval(() => {
    let snap;
    try { snap = snapshot(); } catch (_) { return; }
    if (!snap) return;
    const json = JSON.stringify(snap);
    // Skip identical frames while paused; always send while playing (position).
    if (json === lastJson && !snap.current.isPlaying) return;
    lastJson = json;
    window.postMessage({ __lsBridge: 'deezer', payload: snap }, '*');
  }, POLL_MS);
})();
