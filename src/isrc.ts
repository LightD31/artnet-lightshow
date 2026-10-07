import { messageOf } from './errors.ts';

const DEEZER_API = 'https://api.deezer.com';
const REQUEST_TIMEOUT_MS = 5000;
const DURATION_TOLERANCE_SEC = 3;
const MAX_CACHED = 500;

interface DeezerHit {
  id?: number | string;
  title?: string;
  title_short?: string;
  artist?: { name?: string };
  duration?: number;
}

export interface IsrcQuery {
  artist?: string;
  title?: string;
  durationSec?: number | null;
}

const cache = new Map<string, string | null>();         // normalised query → isrc | null

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

function leadArtist(artist: unknown): string {
  return String(artist || '').split(/,|&| x | and | feat\.? | ft\.? /i)[0].trim();
}

function splitQuery(query: unknown): { artist: string; title: string } | null {
  const text = String(query || '');
  const at = text.indexOf(' - ');
  if (at <= 0) return null;
  const artist = text.slice(0, at).trim();
  const title = text.slice(at + 3).trim();
  return artist && title ? { artist, title } : null;
}

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
  if (body && body.error) throw new Error(`Deezer API: ${body.error.message || body.error.type || 'error'}`);
  return body;
}

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
