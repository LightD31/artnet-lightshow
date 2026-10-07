import { state, universeOf, maxBrightnessOf, setDefaultUniverse, placeAddresslessFixtures } from './state.ts';
import { resizeFixtureBuffers } from './engine.ts';
import { BUILTIN_PROFILE_ID, BUILTIN_PROFILE_IDS, HUE_PROFILE_IDS, isBuiltinProfile, MAX_FIXTURES, universeOverflow, unitCapOverflow, registerProfile, clearNonBuiltinProfiles, listProfiles } from './profiles.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { INTERNAL_UNIVERSE, hasNoAddress, universesOf } from '../shared/placement.ts';
import { ddpConflict } from './ddp-routes.ts';
import { showSchema, validate } from './validation.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import { settings, defaultHueBridgeId } from './settings.ts';
import type { ShowFile } from './validation.ts';
import type { Fixture, Profile } from '../types/rig.ts';
import { configFile } from './config-dir.ts';

const SAVE_DEBOUNCE_MS = 400;

function badShow(message: string): HttpError {
  return new HttpError(400, message);
}

function snapshotShow() {
  const profiles = listProfiles();
  return {
    artnet: { ...state.artnet },
    nextFixtureId: state.nextFixtureId,
    profiles: Object.values(profiles).filter((p) => !isBuiltinProfile(p.id)),
    fixtures: state.fixtures.map((f) => ({
      id: f.id,
      label: f.label,
      ...(hasNoAddress(f) ? {} : { address: f.address, universe: universeOf(f) }),
      profileId: f.profileId,
      maxBrightness: maxBrightnessOf(f),
      position: f.position ? { ...f.position } : null,
      group: f.group || null,
      geometry: f.geometry ? { ...f.geometry } : null,
      output: f.output ? { ...f.output } : null,
    })),
  };
}

function applyShow(rawShow: unknown): ShowFile {
  const show = validate(showSchema, rawShow, 'show');
  const fixtures = Array.isArray(show.fixtures) ? show.fixtures : [];
  const hasFixtures = fixtures.length > 0;
  if (hasFixtures && fixtures.length > MAX_FIXTURES) {
    throw badShow(`Show has ${fixtures.length} fixtures, more than the ${MAX_FIXTURES} supported`);
  }

  const incoming: Record<string, Profile> = Object.create(null);
  for (const id of BUILTIN_PROFILE_IDS) incoming[id] = listProfiles()[id];
  if (Array.isArray(show.profiles)) {
    for (const p of show.profiles) if (p && p.id) incoming[p.id] = p;
  }

  const showUniverse = (show.artnet && show.artnet.universe !== undefined)
    ? show.artnet.universe : state.artnet.universe;

  let next: Fixture[] | null = null;
  if (hasFixtures) {
    const ids = fixtures.map((fixture, i) => fixture.id ?? i);
    if (new Set(ids).size !== ids.length) throw badShow('Show contains duplicate fixture ids');
    const fallback = defaultHueBridgeId(settings.group('hue').bridges);
    next = fixtures.map((f, i): Fixture => ({
      id: ids[i],
      label: f.label || `Fixture ${i + 1}`,
      address: f.address || 1,
      universe: f.universe !== undefined ? f.universe : showUniverse,
      profileId: f.profileId !== undefined && incoming[f.profileId] ? f.profileId : BUILTIN_PROFILE_ID,
      maxBrightness: f.maxBrightness !== undefined ? f.maxBrightness : 255,
      position: f.position ? { ...f.position } : null,
      group: f.group || null,
      geometry: f.geometry ? { ...f.geometry } : null,
      output: !f.output ? null
        : f.output.protocol === 'hue' ? { ...f.output, bridge: f.output.bridge || fallback } : { ...f.output },
      override: null,
    }));
    const mixed = next.find((f) => hasNoAddress(f) !== HUE_PROFILE_IDS.has(f.profileId));
    if (mixed) {
      throw badShow(`"${mixed.label}" ${hasNoAddress(mixed) ? 'is a Hue lamp on a profile that is not one' : 'is on a Hue lamp profile but not a Hue lamp'}`);
    }
    const channels = new Map<string, string>();
    for (const fix of next) {
      if (fix.output?.protocol !== 'hue') continue;
      const key = `${fix.output.bridge}:${fix.output.channel}`;
      const other = channels.get(key);
      if (other) throw badShow(`"${fix.label}" and "${other}" are both Hue channel ${fix.output.channel} of bridge ${fix.output.bridge}`);
      channels.set(key, fix.label);
    }
    placeAddresslessFixtures(next, (fix) => incoming[fix.profileId]);
    for (const fix of next) {
      const overflow = hasNoAddress(fix)
        ? universeOverflow(fix.label, 1, incoming[fix.profileId], INTERNAL_UNIVERSE)
        : universeOverflow(fix.label, fix.address, incoming[fix.profileId], fix.universe);
      if (overflow) throw badShow(overflow);
    }
    const tooMany = unitCapOverflow(next, (fix) => incoming[fix.profileId]);
    if (tooMany) throw badShow(tooMany);
    const wled = ddpConflict(next, (fix) => incoming[fix.profileId] as Profile, (fix) => fix.universe as number);
    if (wled) throw badShow(wled);
    const spanned = new Set([showUniverse, ...next.flatMap((f) => universesOf(f.universe as number, incoming[f.profileId]))]);
    if (spanned.size > MAX_UNIVERSES) {
      throw badShow(`Show spans ${spanned.size} universes, more than the ${MAX_UNIVERSES} this server transmits`);
    }
  }

  if (Array.isArray(show.profiles)) {
    clearNonBuiltinProfiles();
    show.profiles.forEach((p) => { if (p && p.id) registerProfile(p); });
  }
  if (show.artnet) {
    const { universe, ...rest } = show.artnet;
    Object.assign(state.artnet, rest);
    if (universe !== undefined) {
      if (next) state.artnet.universe = universe;
      else setDefaultUniverse(universe);
    }
  }
  if (next) {
    state.fixtures = next;
    const highest = next.reduce((max, fixture) => Math.max(max, fixture.id), -1);
    state.nextFixtureId = Math.max(state.nextFixtureId, show.nextFixtureId || 0, highest + 1);
    resizeFixtureBuffers();
  }
  return show;
}

class ShowStore extends JsonStore {
  declare _debounceMs: number;
  declare _timer: ReturnType<typeof setTimeout> | null;
  declare _saved: string | null;

  constructor(file: string, { debounceMs = SAVE_DEBOUNCE_MS } = {}) {
    super(file, { tag: 'show', fallback: 'starting on the default patch' });
    this._debounceMs = debounceMs;
    this._timer = null;
    this._saved = null;
  }

  load(): unknown {
    return this.readJson() ?? null;
  }

  restore(): boolean {
    const show = this.load();
    if (!show) return false;
    try {
      applyShow(show);
    } catch (err) {
      this.quarantine(`does not fit this rig (${messageOf(err)})`);
      return false;
    }
    // In sync with the file now, so no change-driven write repeats it.
    this._saved = this._serialise();
    return true;
  }

  _serialise(): string {
    return `${JSON.stringify(snapshotShow(), null, 2)}\n`;
  }

  scheduleSave(): void {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, this._debounceMs);
    // A pending save must not hold the process open; shutdown flushes it.
    if (this._timer.unref) this._timer.unref();
  }

  save(): boolean {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const body = this._serialise();
    if (body === this._saved) return false;
    try {
      this.write(body);
      this._saved = body;
      return true;
    } catch (err) {
      console.warn(`[show] could not save the patch to ${this.file}: ${messageOf(err)}`);
      return false;
    }
  }
}

const SHOW_FILE = configFile('show.json');
const showStore = new ShowStore(SHOW_FILE);

export {
  showStore,
  ShowStore,
  SHOW_FILE,
  snapshotShow,
  applyShow,
};
