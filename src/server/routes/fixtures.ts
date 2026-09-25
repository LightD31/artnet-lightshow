import { state, allocateFixtureId, universeOf, maxBrightnessOf, countUniverses } from '../state.ts';
import { resizeFixtureBuffers } from '../engine.ts';
import { parseGDTF } from '../../gdtf.ts';
import { BUILTIN_PROFILE_ID, isBuiltinProfile, MAX_FIXTURES, UNIVERSE_SIZE, endChannel, fitsInUniverse, universeOverflow, registerProfile, unregisterProfile, listProfiles, getProfile, unitCapOverflow } from '../profiles.ts';
import { MAX_UNIVERSES } from '../universes.ts';
import { footprintOf, universeCount } from '../../shared/placement.ts';
import { ddpConflict } from '../ddp-routes.ts';
import { showStore, snapshotShow, applyShow } from '../show-store.ts';
import { barProfile } from '../bar-profile.ts';
import { parseOfl } from '../ofl.ts';
import { wledProfile } from '../wled.ts';
import { profileSchema, fixtureRestoreSchema, fixtureAddSchema, wledAddSchema, validate } from '../validation.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import type { Fixture, Profile } from '../../types/rig.ts';
import { asyncHandler, uploadGdtf, uploadOfl } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * The patch: fixture profiles (GDTF, the Open Fixture Library, a bar built
 * from its manual), WLEDs, the fixtures themselves, and the show file.
 */
export function attachFixtureRoutes(app: Express, ctx: RouteContext): void {
  const { integrations, oflLibrary, wled } = ctx;

  // ─── GDTF / Profiles / Fixtures / Show ────────────────────────────────────
  app.post('/api/gdtf/parse', uploadGdtf.single('gdtf'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    try {
      const result = await parseGDTF(req.file.buffer);
      res.json({ ok: true, fixture: result });
    } catch (err) {
      console.error('GDTF parse error:', messageOf(err));
      res.status(400).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── Open Fixture Library ─────────────────────────────────────────────────
  // A downloaded OFL fixture file (no internet needed), or a fixture searched
  // for and fetched from the library online. Both answer as /api/gdtf/parse
  // does, so the page offers their modes the same way.
  app.post('/api/ofl/parse', uploadOfl.single('ofl'), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    let json: unknown;
    try {
      json = JSON.parse(req.file.buffer.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'That file is not JSON: an Open Fixture Library fixture is a .json file' });
    }
    try {
      const manufacturer = typeof req.body?.manufacturer === 'string' ? req.body.manufacturer.trim() : null;
      res.json({ ok: true, fixture: parseOfl(json, { manufacturer }) });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  });

  app.get('/api/ofl/search', asyncHandler(async (req, res) => {
    try {
      const results = await oflLibrary.search(typeof req.query.q === 'string' ? req.query.q : '');
      res.json({ ok: true, results });
    } catch (err) {
      res.status(statusOf(err) || 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.get('/api/ofl/fixture/:manufacturer/:fixture', asyncHandler(async (req, res) => {
    try {
      const fixture = await oflLibrary.fixture(String(req.params.manufacturer), String(req.params.fixture));
      res.json({ ok: true, fixture });
    } catch (err) {
      res.status(statusOf(err) || 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── WLED ─────────────────────────────────────────────────────────────────
  // Find the WLEDs on the network, and add one: its profile from what it says
  // it is, patched on universes of its own and sent DDP (ddp-routes.ts).
  app.get('/api/wled/discover', asyncHandler(async (_req, res) => {
    try {
      const found = await wled.discover();
      const devices = await Promise.all(found.map(async (device) => {
        const patched = state.fixtures.find((f) => f.output?.protocol === 'ddp' && f.output.host === device.host);
        const base = { ...device, patched: patched ? patched.label : null };
        try {
          const info = await wled.info(device.host);
          return { ...base, name: info.name, leds: info.leds, rgbw: info.rgbw, matrix: info.matrix, version: info.version };
        } catch (err) {
          return { ...base, error: messageOf(err) };
        }
      }));
      res.json({ ok: true, devices });
    } catch (err) {
      res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.post('/api/wled/add', asyncHandler(async (req, res) => {
    try {
      const { host, label } = validate(wledAddSchema, req.body || {}, 'wled');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }
      const sameHost = state.fixtures.find((f) => f.output?.protocol === 'ddp' && f.output.host.toLowerCase() === host.toLowerCase());
      if (sameHost) return res.status(409).json({ ok: false, error: `${host} is patched already, as "${sameHost.label}"` });

      const info = await wled.info(host);
      const profile = wledProfile(info, host);
      // The profile is named for the WLED's own address (its MAC), so the same
      // device found at a new IP is the fixture that is already there.
      const sameDevice = state.fixtures.find((f) => f.profileId === profile.id);
      if (sameDevice) {
        return res.status(409).json({ ok: false, error: `${info.name} is patched already, as "${sameDevice.label}"; change its address in the patch table` });
      }
      const universe = freeUniverses(universeCount(profile));
      if (universe === null) return res.status(400).json({ ok: false, error: 'No free universes left for it' });
      const fixture: Fixture = {
        id: -1, label: (label || info.name).slice(0, 64), address: 1, universe, profileId: profile.id, maxBrightness: 255,
        override: null, position: null, group: null, geometry: null, output: { protocol: 'ddp', host },
      };
      const next = [...state.fixtures, fixture];
      const profileOf = (f: Pick<Fixture, 'profileId'>) => (f.profileId === profile.id ? profile : getProfile(f));
      const tooMany = unitCapOverflow(next, profileOf);
      if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
      if (countUniverses(next, profileOf) > MAX_UNIVERSES) {
        return res.status(400).json({ ok: false, error: `${info.name} would put the patch on more than the ${MAX_UNIVERSES} universes this server transmits` });
      }
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      fixture.id = allocateFixtureId();
      state.fixtures.push(fixture);
      resizeFixtureBuffers();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, fixture, profile, info });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  }));

  /**
   * The first run of `count` universes nothing is patched on, from 1: the
   * rig's default universe stays clear, since new fixtures land on it.
   */
  function freeUniverses(count: number): number | null {
    const used = new Set<number>([state.artnet.universe]);
    for (const f of state.fixtures) for (const part of footprintOf(universeOf(f), f.address, getProfile(f))) used.add(part.universe);
    for (let u = 1; u + count - 1 <= 32767; u++) {
      let free = true;
      for (let k = 0; k < count && free; k++) free = !used.has(u + k);
      if (free) return u;
    }
    return null;
  }

  app.post('/api/profiles', (req, res) => {
    try {
      const profile = validate(profileSchema, req.body, 'profile');
      // Re-importing a profile that is already patched changes every fixture
      // on it at once — a GDTF that now counts its fine channels is a channel
      // longer — so those fixtures are held to the same rules as patching them.
      const blocked = profileChangeBlocked(profile);
      if (blocked) return res.status(400).json({ ok: false, error: blocked });
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // A bar profile from its cell count and channel order (bar-profile.js).
  // `?dryRun=1` answers with the profile without adding it, for the preview.
  app.post('/api/profiles/bar', (req, res) => {
    try {
      const profile = barProfile(req.body || {});
      if (req.query.dryRun === '1') return res.json({ ok: true, profile });
      if (isBuiltinProfile(profile.id)) return res.status(400).json({ ok: false, error: 'That id is a built-in profile' });
      const blocked = profileChangeBlocked(profile);
      if (blocked) return res.status(400).json({ ok: false, error: blocked });
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, profile });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  /** Why replacing a profile with `profile` would break the patch, or null. */
  function profileChangeBlocked(profile: Profile): string | null {
    const users = state.fixtures.filter((f) => f.profileId === profile.id);
    for (const fixture of users) {
      const overflow = universeOverflow(fixture.label, fixture.address, profile, universeOf(fixture));
      if (overflow) return overflow;
    }
    if (!users.length) return null;
    const profiles = listProfiles();
    const profileOf = (f: Pick<Fixture, 'profileId'>) => (f.profileId === profile.id ? profile : profiles[f.profileId] || profiles[BUILTIN_PROFILE_ID]);
    // A WLED's profile growing reaches onto more universes, which must be free.
    return unitCapOverflow(state.fixtures, profileOf) || ddpConflict(state.fixtures, profileOf, universeOf);
  }

  app.delete('/api/profiles/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltinProfile(id)) return res.status(400).json({ ok: false, error: 'Cannot remove built-in profile' });
    const inUse = state.fixtures.some((f) => f.profileId === id);
    if (inUse) return res.status(400).json({ ok: false, error: 'Profile is in use by patched fixtures' });
    unregisterProfile(id);
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true });
  });

  /**
   * Add fixtures: one generic par behind whatever is on the rig's default
   * universe, as the patch table's "+" always has — or, with a body, `count`
   * of one profile from an address on a universe, one after another. A
   * universe that fills goes on to the next, and a strip longer than a
   * universe starts at channel 1 of universes of its own, so "sixteen bars
   * from address 1" is one request rather than sixteen and some arithmetic.
   */
  app.post('/api/fixtures', (req, res) => {
    let body;
    try {
      body = validate(fixtureAddSchema, req.body || {}, 'fixtures');
    } catch (err) {
      return res.status(400).json({ ok: false, error: messageOf(err) });
    }
    const count = body.count ?? 1;
    if (state.fixtures.length + count > MAX_FIXTURES) {
      return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
    }
    const profiles = listProfiles();
    const profileId = body.profileId ?? BUILTIN_PROFILE_ID;
    const profile = profiles[profileId];
    if (!profile) return res.status(400).json({ ok: false, error: `No profile "${profileId}"` });

    // What is taken, per universe: the last channel used on it, a strip
    // running on into it included, and new fixtures as they are placed.
    const lastUsed = new Map<number, number>();
    const take = (universe: number, address: number) => {
      for (const part of footprintOf(universe, address, profile)) {
        lastUsed.set(part.universe, Math.max(lastUsed.get(part.universe) || 0, part.last));
      }
    };
    for (const fix of state.fixtures) {
      for (const part of footprintOf(universeOf(fix), fix.address, profiles[fix.profileId] || profiles[BUILTIN_PROFILE_ID])) {
        lastUsed.set(part.universe, Math.max(lastUsed.get(part.universe) || 0, part.last));
      }
    }
    const span = universeCount(profile);
    const placed: { universe: number; address: number }[] = [];
    let universe = body.universe ?? state.artnet.universe;
    let address = body.address ?? (lastUsed.get(universe) || 0) + 1;
    for (let k = 0; k < count; k++) {
      if (span > 1) {
        // A strip: channel 1 of as many empty universes as it runs over.
        const free = (u: number) => [...Array(span).keys()].every((j) => !lastUsed.has(u + j));
        if (address !== 1 || !free(universe)) {
          while (universe <= 32767 && !free(universe)) universe++;
          address = 1;
        }
      } else if (!fitsInUniverse(address, profile.channelCount)) {
        if (k === 0 && body.address !== undefined) {
          return res.status(400).json({
            ok: false,
            error: `A ${profile.channelCount}-channel fixture at ${address} would end at `
              + `${endChannel(address, profile.channelCount)}, past the ${UNIVERSE_SIZE}-channel universe`,
          });
        }
        // Full: behind whatever is on the next universe that has room.
        do {
          universe++;
          address = (lastUsed.get(universe) || 0) + 1;
        } while (universe <= 32767 && !fitsInUniverse(address, profile.channelCount));
      }
      if (universe > 32767) return res.status(400).json({ ok: false, error: 'No room left on any universe' });
      placed.push({ universe, address });
      take(universe, address);
      if (span > 1) { universe += span; address = 1; } else address += profile.channelCount;
    }

    const labelOf = (id: number, k: number) => (body.label ? (count > 1 ? `${body.label} ${k + 1}` : body.label) : `Fixture ${id + 1}`);
    const draft = placed.map((p, k) => ({ id: -1 - k, label: labelOf(state.fixtures.length + k, k), ...p, profileId }));
    const next = [...state.fixtures, ...draft];
    const tooMany = unitCapOverflow(next);
    if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
    const wled = ddpConflict(next, getProfile, universeOf);
    if (wled) return res.status(400).json({ ok: false, error: wled });
    if (countUniverses(next) > MAX_UNIVERSES) {
      return res.status(400).json({
        ok: false,
        error: `${count > 1 ? 'These fixtures' : `Universe ${placed[0].universe}`} would put the patch on more than the ${MAX_UNIVERSES} `
          + 'universes this server transmits',
      });
    }
    const ids: number[] = [];
    placed.forEach((p, k) => {
      const id = allocateFixtureId();
      ids.push(id);
      state.fixtures.push({
        id,
        label: labelOf(id, k),
        address: p.address,
        universe: p.universe,
        profileId,
        maxBrightness: 255,
        override: null,
      });
    });
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true, fixtures: ids, placed });
  });

  // Answers with the fixture that was removed and its position, so the client
  // can offer an undo. The id is stable because external bindings refer to it.
  app.delete('/api/fixtures/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (state.fixtures.length <= 1) return res.status(400).json({ ok: false, error: 'Must have at least one fixture' });
    const index = state.fixtures.findIndex((f) => f.id === id);
    if (index < 0) return res.status(404).json({ ok: false, error: 'No such fixture' });

    const [removed] = state.fixtures.splice(index, 1);
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({
      ok: true,
      index,
      fixture: {
        id: removed.id,
        label: removed.label,
        address: removed.address,
        universe: universeOf(removed),
        profileId: removed.profileId,
        maxBrightness: maxBrightnessOf(removed),
        position: removed.position || null,
        group: removed.group || null,
        geometry: removed.geometry || null,
        output: removed.output || null,
        override: removed.override,
      },
    });
  });

  /**
   * Put a deleted fixture back at its old index.
   *
   * Held to exactly the same rules as adding one — the patch may have changed
   * in the seconds the undo was on screen, and an undo that reintroduces an
   * overlap or overflows a universe is worse than no undo at all.
   */
  app.post('/api/fixtures/restore', (req, res) => {
    try {
      const { index, fixture } = validate(fixtureRestoreSchema, req.body || {}, 'fixture-restore');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }

      const profiles = listProfiles();
      const profileId = profiles[fixture.profileId] ? fixture.profileId : BUILTIN_PROFILE_ID;
      const overflow = universeOverflow(fixture.label, fixture.address, profiles[profileId], fixture.universe ?? state.artnet.universe);
      if (overflow) return res.status(400).json({ ok: false, error: overflow });

      const restored = {
        id: fixture.id,
        label: fixture.label,
        address: fixture.address,
        universe: fixture.universe !== undefined ? fixture.universe : state.artnet.universe,
        profileId,
        maxBrightness: fixture.maxBrightness !== undefined ? fixture.maxBrightness : 255,
        position: fixture.position || null,
        group: fixture.group || null,
        geometry: fixture.geometry || null,
        output: fixture.output || null,
        override: fixture.override || null,
      };

      if (state.fixtures.some((existing) => existing.id === restored.id)) {
        return res.status(409).json({ ok: false, error: 'That fixture id is already in use' });
      }

      const tooMany = unitCapOverflow([...state.fixtures, restored]);
      if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
      const wled = ddpConflict([...state.fixtures, restored as Fixture], getProfile, universeOf);
      if (wled) return res.status(400).json({ ok: false, error: wled });

      if (countUniverses([...state.fixtures, restored]) > MAX_UNIVERSES) {
        return res.status(400).json({
          ok: false,
          error: `Universe ${restored.universe} would put the patch on more than the ${MAX_UNIVERSES} `
            + 'universes this server transmits',
        });
      }

      const at = Math.max(0, Math.min(state.fixtures.length, index));
      if (restored.id === undefined) restored.id = allocateFixtureId();
      state.nextFixtureId = Math.max(state.nextFixtureId, restored.id + 1);
      state.fixtures.splice(at, 0, restored as typeof restored & { id: number });
      resizeFixtureBuffers();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, id: restored.id });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // The show file: the patch as a portable document. The server saves it for
  // the operator on every change (see show-store.js), so this is for moving a
  // rig between machines or keeping a copy, not for not losing your work.
  app.get('/api/show', (_req, res) => res.json(snapshotShow()));

  app.post('/api/show', (req, res) => {
    try {
      applyShow(req.body);
      // The uploaded show is the rig now, so it is also what a restart restores.
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });
}
