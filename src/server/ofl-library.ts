/**
 * The Open Fixture Library online: search it, and fetch a fixture from it.
 *
 * It only ever talks to open-fixture-library.org, with fixture keys checked
 * to be what OFL keys are, so the routes in front of it cannot be turned into
 * a way of fetching any URL from the server. Every answer is bounded in time
 * and size: the library is someone else's server. Offline, the settings page
 * still imports a downloaded OFL file (ofl.ts) without any of this.
 */

import { HttpError, messageOf } from '../errors.ts';
import { parseOfl } from './ofl.ts';
import type { ImportedFixture } from '../types/rig.ts';

const ORIGIN = 'https://open-fixture-library.org';
// Manufacturer and fixture keys: lowercase letters, digits and dashes.
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
// A maker's fixture list changes when the library is updated, a few times a
// month; an hour spares a search from asking again for every result.
const LIST_TTL_MS = 60 * 60 * 1000;
const MAX_RESULTS = 30;

/** One fixture a search found. */
export interface SearchHit {
  manufacturerKey: string;
  fixtureKey: string;
  manufacturer: string;
  name: string;
  categories: string[];
}

interface MakerList {
  name: string;
  fixtures: { key: string; name: string; categories: string[] }[];
}

export interface OflLibrary {
  search(query: string): Promise<SearchHit[]>;
  fixture(manufacturerKey: string, fixtureKey: string): Promise<ImportedFixture>;
}

/**
 * @param fetchImpl  the fetch to use (tests pass a stand-in)
 * @param now        the clock the fixture-list cache runs on
 */
function createOflLibrary({ fetchImpl = fetch, now = Date.now }: { fetchImpl?: typeof fetch; now?: () => number } = {}): OflLibrary {
  const lists = new Map<string, { at: number; list: Promise<MakerList> }>();

  /** GET or POST a path of the library, and its answer as JSON. */
  async function getJson(path: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      let url = new URL(path, ORIGIN);
      for (let hop = 0; ; hop++) {
        const res = await fetchImpl(url, { ...init, signal, redirect: 'manual', headers: { accept: 'application/json', ...init.headers } });
        // A renamed fixture redirects to its new name. Followed by hand, and
        // only within the library.
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const next = new URL(res.headers.get('location') as string, url);
          if (next.origin !== ORIGIN || hop >= MAX_REDIRECTS) throw new HttpError(502, 'The Open Fixture Library redirected somewhere else');
          url = next;
          continue;
        }
        if (res.status === 404) throw new HttpError(404, 'The Open Fixture Library has no such fixture');
        if (!res.ok) throw new HttpError(502, `The Open Fixture Library answered ${res.status}`);
        const text = await readCapped(res);
        try {
          return JSON.parse(text);
        } catch (_) {
          throw new HttpError(502, 'The Open Fixture Library answered with something that is not JSON');
        }
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new HttpError(504, `The Open Fixture Library did not answer within ${TIMEOUT_MS / 1000} s`);
      }
      const cause = err instanceof Error && err.cause ? `: ${messageOf(err.cause)}` : '';
      throw new HttpError(502, `Cannot reach the Open Fixture Library (${messageOf(err)}${cause}). A downloaded OFL file imports without it.`);
    }
  }

  /** A maker's name and fixture list, kept for an hour. A failed fetch is not kept. */
  function makerList(key: string): Promise<MakerList> {
    const hit = lists.get(key);
    if (hit && now() - hit.at < LIST_TTL_MS) return hit.list;
    const list = getJson(`/api/v1/manufacturers/${key}`).then(readMakerList);
    lists.set(key, { at: now(), list });
    list.catch(() => { if (lists.get(key)?.list === list) lists.delete(key); });
    return list;
  }

  async function search(query: string): Promise<SearchHit[]> {
    const q = String(query || '').trim();
    if (q.length < 2 || q.length > 100) throw new HttpError(400, 'Search for 2 to 100 characters');
    const found = await getJson('/api/v1/get-search-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchQuery: q, manufacturersQuery: [], categoriesQuery: [] }),
    });
    if (!Array.isArray(found)) throw new HttpError(502, 'The Open Fixture Library answered the search with something else');
    const keys = found
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.split('/'))
      .filter((parts) => parts.length === 2 && KEY.test(parts[0]) && KEY.test(parts[1]))
      .slice(0, MAX_RESULTS);
    // The search answers with keys; the names are in each maker's list. A
    // maker whose list does not come shows its keys rather than failing all.
    const makers = [...new Set(keys.map(([maker]) => maker))];
    const listed = new Map(await Promise.all(makers.map(async (maker) =>
      [maker, await makerList(maker).catch(() => null)] as const)));
    return keys.map(([maker, key]) => {
      const list = listed.get(maker);
      const fixture = list?.fixtures.find((f) => f.key === key);
      return {
        manufacturerKey: maker,
        fixtureKey: key,
        manufacturer: list?.name || maker,
        name: fixture?.name || key,
        categories: fixture?.categories || [],
      };
    });
  }

  async function fixture(manufacturerKey: string, fixtureKey: string): Promise<ImportedFixture> {
    if (!KEY.test(manufacturerKey) || !KEY.test(fixtureKey)) {
      throw new HttpError(400, 'Not an Open Fixture Library fixture: keys are lowercase letters, digits and dashes');
    }
    const [json, maker] = await Promise.all([
      getJson(`/${manufacturerKey}/${fixtureKey}.json`),
      makerList(manufacturerKey).catch(() => null),
    ]);
    return parseOfl(json, { manufacturer: maker?.name || manufacturerKey });
  }

  return { search, fixture };
}

/** A maker's entry from the library's API, with anything unexpected dropped. */
function readMakerList(raw: unknown): MakerList {
  const record = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; fixtures?: unknown };
  const fixtures = Array.isArray(record.fixtures) ? record.fixtures : [];
  return {
    name: typeof record.name === 'string' ? record.name.slice(0, 128) : '',
    fixtures: fixtures
      .filter((f): f is { key: string; name: string; categories?: unknown } =>
        !!f && typeof f.key === 'string' && typeof f.name === 'string')
      .map((f) => ({
        key: f.key,
        name: f.name.slice(0, 128),
        categories: Array.isArray(f.categories) ? f.categories.filter((c): c is string => typeof c === 'string').slice(0, 8) : [],
      })),
  };
}

/** A response body as text, refused past MAX_BYTES however it is sent. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw tooLarge();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tooLarge(): HttpError {
  return new HttpError(502, `The Open Fixture Library sent more than ${MAX_BYTES / 1024 / 1024} MB`);
}

export {
  createOflLibrary,
};
