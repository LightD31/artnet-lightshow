/**
 * Find a recording's ISRC from its artist, title and length.
 *
 * The ISRC is what lets the Deezer path fetch the exact recording that is
 * playing, rather than whatever a YouTube search turns up first — a radio edit
 * for an extended mix, a live take, a lyric video with a spoken intro — any of
 * which puts every cue in the wrong place.
 *
 * Not every source has one to give. The OS media session and PRO DJ LINK never
 * carry it, and Spotify's February 2026 migration guide lists `external_ids`
 * as removed for development-mode apps — though Spotify still sends it to many
 * of them, and whenever it does, that one is used and nothing is looked up.
 * For the rest, Deezer's public catalogue API answers without a key: search by
 * artist and title, keep only candidates whose length matches, and read the
 * ISRC off the best one.
 *
 * The length check is what makes this safe. Two recordings with the same title
 * and artist but different edits differ in length, and the target length comes
 * from the source that is actually playing — so a match is the right edit, and
 * no match is an honest "don't know" that falls back to the search.
 */

import { messageOf } from './errors.ts';

const DEEZER_API = 'https://api.deezer.com';
const REQUEST_TIMEOUT_MS = 5000;
// Edits of one song differ by far more than this; the same master reported by
// two services differs by a second or two of silence at the ends.
const DURATION_TOLERANCE_SEC = 3;
const MAX_CACHED = 500;

/** A track as Deezer's search returns it. */
interface DeezerHit {
  id?: number | string;
  title?: string;
  title_short?: string;
  artist?: { name?: string };
  duration?: number;
}

/** What is known of the track whose ISRC is wanted. */
export interface IsrcQuery {
  artist?: string;
  title?: string;
  durationSec?: number | null;
}

const cache = new Map<string, string | null>();         // normalised query → isrc | null

/** Lower-case, drop accents, bracketed asides and "feat." credits, collapse to words. */
function normalise(text: unknown): string {
  return String(text || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The first credited artist: "Daft Punk, Pharrell Williams" → "Daft Punk". */
function leadArtist(artist: unknown): string {
  return String(artist || '').split(/,|&| x | and | feat\.? | ft\.? /i)[0].trim();
}

/**
 * Split the "Artist - Title" query every source builds back into its parts.
 * The first " - " is the separator: artist names almost never contain one,
 * titles often do ("Song - Remastered 2011").
 */
function splitQuery(query: unknown): { artist: string; title: string } | null {
  const text = String(query || '');
  const at = text.indexOf(' - ');
  if (at <= 0) return null;
  const artist = text.slice(0, at).trim();
  const title = text.slice(at + 3).trim();
  return artist && title ? { artist, title } : null;
}

/** Does a Deezer search hit describe the recording we are looking for? */
function matches(hit: DeezerHit | null | undefined, { artist, title, durationSec }: IsrcQuery): boolean {
  if (!hit || !hit.id) return false;
  const wantTitle = normalise(title);
  const gotTitle = normalise(hit.title_short || hit.title);
  if (!wantTitle || !gotTitle) return false;
  if (gotTitle !== wantTitle && !gotTitle.startsWith(wantTitle) && !wantTitle.startsWith(gotTitle)) return false;

  const wantArtist = normalise(leadArtist(artist));
  const gotArtist = normalise(hit.artist && hit.artist.name);
  if (!wantArtist || !gotArtist) return false;
  if (!gotArtist.includes(wantArtist) && !wantArtist.includes(gotArtist)) return false;

  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
    return typeof hit.duration === 'number' && Number.isFinite(hit.duration)
      && Math.abs(hit.duration - durationSec) <= DURATION_TOLERANCE_SEC;
  }
  return true;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Deezer API ${res.status}`);
  const body = await res.json() as { error?: { message?: string; type?: string } } | null;
  // Deezer reports errors, quota included, as a 200 with an error object.
  if (body && body.error) throw new Error(`Deezer API: ${body.error.message || body.error.type || 'error'}`);
  return body;
}

/**
 * Resolve an ISRC, or null when no candidate is a confident match.
 *
 * Never throws for a miss or a network problem — the caller has a fallback and
 * a lookup failure is not worth failing the track over. Results, misses
 * included, are remembered for the life of the process.
 */
async function resolveIsrc({ artist, title, durationSec }: IsrcQuery = {},
  { fetchImpl = fetch, log = console }: { fetchImpl?: typeof fetch; log?: Pick<Console, 'warn'> } = {}): Promise<string | null> {
  if (!artist || !title) return null;
  const key = `${normalise(leadArtist(artist))}|${normalise(title)}|${Math.round(durationSec || 0)}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  let isrc: string | null = null;
  try {
    const q = `artist:"${leadArtist(artist).replace(/"/g, '')}" track:"${String(title).replace(/"/g, '')}"`;
    const search = await getJson(`${DEEZER_API}/search?q=${encodeURIComponent(q)}&limit=10`, fetchImpl) as { data?: unknown } | null;
    const data = search && search.data;
    const hits = (Array.isArray(data) ? data as DeezerHit[] : [])
      .filter((hit) => matches(hit, { artist, title, durationSec }))
      .sort((a, b) => Math.abs((a.duration as number) - (durationSec || 0)) - Math.abs((b.duration as number) - (durationSec || 0)));
    if (hits.length) {
      const track = await getJson(`${DEEZER_API}/track/${encodeURIComponent(String(hits[0].id))}`, fetchImpl) as { isrc?: unknown } | null;
      if (track && typeof track.isrc === 'string' && /^[A-Z0-9]{12}$/i.test(track.isrc)) {
        isrc = track.isrc.toUpperCase();
      }
    }
  } catch (err) {
    log.warn(`[isrc] lookup failed for "${artist} - ${title}": ${messageOf(err)}`);
    // Not remembered: a network blip should not decide this track for the night.
    return null;
  }

  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(key, isrc);
  return isrc;
}

export {
  resolveIsrc,
  splitQuery,
  normalise,
  cache as _cache,
};
