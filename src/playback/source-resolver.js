'use strict';

const crypto = require('crypto');
const fs = require('fs');

function normalize(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

/** Convert any source adapter's metadata into the common playback contract. */
function resolveTrack(input = {}) {
  const out = {
    source: input.source || 'unknown',
    track_id: input.track_id ?? input.trackId ?? null,
    isrc: input.isrc || null,
    title: input.title || input.name || '',
    artist: input.artist || '',
    duration: Number.isFinite(input.duration) ? input.duration : (Number(input.durationMs) / 1000 || 0),
    position: Number.isFinite(input.position) ? input.position : (Number(input.positionMs) / 1000 || 0),
    playing: input.playing === true,
  };
  out.key = trackKey(out, input);
  return out;
}

function trackKey(track, input = {}) {
  if (input.fileHash || track.fileHash) return `file:${input.fileHash || track.fileHash}`;
  if (input.filepath || input.path) {
    try {
      const b = fs.readFileSync(input.filepath || input.path);
      return `file:${crypto.createHash('sha1').update(b).digest('hex')}`;
    } catch (_) { /* fall through */ }
  }
  if (track.source === 'spotify' && track.track_id && track.isrc) return `spotify:${track.track_id}:${track.isrc}`;
  if (track.track_id) return `${track.source}:${track.track_id}`;
  return normalize(`${track.artist} - ${track.title} - ${track.duration.toFixed(2)}`) || null;
}

module.exports = { resolveTrack, trackKey };
