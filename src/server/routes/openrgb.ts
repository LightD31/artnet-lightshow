import { state, allocateFixtureId, universeOf, countUniverses, freeUniverses } from '../state.ts';
import { resizeFixtureBuffers } from '../engine.ts';
import { MAX_FIXTURES, getProfile, registerProfile, unitCapOverflow } from '../profiles.ts';
import { MAX_UNIVERSES } from '../universes.ts';
import { universeCount } from '../../shared/placement.ts';
import { ddpConflict } from '../ddp-routes.ts';
import { openrgbKey, openrgbOutputOf } from '../openrgb-routes.ts';
import { OPENRGB_PORT } from '../openrgb.ts';
import { openrgbProfile } from '../openrgb-devices.ts';
import { showStore } from '../show-store.ts';
import { openrgbAddSchema, openrgbHostSchema, validate } from '../validation.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import type { Fixture, OpenRgbOutput, Profile } from '../../types/rig.ts';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * The devices of an OpenRGB SDK server — a gaming PC's RAM, board, GPU,
 * keyboard, mouse, monitors — and adding them to the patch: each a fixture
 * of its own, its LEDs as cells, on universes of its own, sent one packet a
 * frame over the SDK (openrgb.ts, openrgb-routes.ts).
 *
 *   GET  /api/openrgb/discover?host=&port=   what the server lists
 *   POST /api/openrgb/add                     { host, port?, devices?, label? }
 */
export function attachOpenRgbRoutes(app: Express, ctx: RouteContext): void {
  const { integrations, openrgb } = ctx;

  /** The fixture on a device of this server, if one is patched. */
  const patchedOn = (host: string, port: number) => {
    const mine = new Map<number, Fixture>();
    for (const fix of state.fixtures) {
      const output = openrgbOutputOf(fix);
      if (output && openrgbKey({ host: output.host, port: output.port ?? OPENRGB_PORT, device: output.device }) === openrgbKey({ host, port, device: output.device })) {
        mine.set(output.device, fix);
      }
    }
    return mine;
  };

  app.get('/api/openrgb/discover', asyncHandler(async (req, res) => {
    try {
      const { host, port = OPENRGB_PORT } = validate(openrgbHostSchema, { host: req.query.host, ...(req.query.port !== undefined ? { port: req.query.port } : {}) }, 'openrgb');
      const devices = await openrgb.discover(host, port);
      const patched = patchedOn(host, port);
      res.json({
        ok: true, host, port,
        devices: devices.map((d) => ({ ...d, patched: patched.get(d.index)?.label ?? null })),
      });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  }));

  /** Patch devices of the server: those named, or every one with LEDs not patched yet. */
  app.post('/api/openrgb/add', asyncHandler(async (req, res) => {
    try {
      const { host, port = OPENRGB_PORT, devices: wanted, label } = validate(openrgbAddSchema, req.body || {}, 'openrgb');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }
      const listed = await openrgb.discover(host, port);
      const patched = patchedOn(host, port);
      for (const index of wanted || []) {
        const device = listed.find((d) => d.index === index);
        if (!device) return res.status(404).json({ ok: false, error: `OpenRGB at ${host} has no device #${index}; it lists ${listed.length}` });
        if (device.leds < 1) return res.status(400).json({ ok: false, error: `${device.name} (#${index}) has no LEDs to light` });
        const already = patched.get(index);
        if (already) return res.status(409).json({ ok: false, error: `${device.name} (#${index}) is patched already, as "${already.label}"` });
      }
      const fresh = listed.filter((d) => (wanted ? wanted.includes(d.index) : d.leds >= 1 && !patched.has(d.index)));
      if (!fresh.length) {
        return res.status(409).json({ ok: false, error: listed.length ? `Every device of OpenRGB at ${host} is patched already` : `OpenRGB at ${host} lists no devices` });
      }
      if (state.fixtures.length + fresh.length > MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `${fresh.length} devices would take the patch past ${MAX_FIXTURES} fixtures` });
      }
      const built = fresh.map((device) => ({ device, profile: openrgbProfile(device, host, port) }));
      const taken = new Set<number>();
      const draft: Fixture[] = [];
      for (const { device, profile } of built) {
        const universe = freeUniverses(universeCount(profile), taken);
        if (universe === null) return res.status(400).json({ ok: false, error: 'No free universes left for it' });
        for (let k = 0; k < universeCount(profile); k++) taken.add(universe + k);
        const output: OpenRgbOutput = { protocol: 'openrgb', host, ...(port === OPENRGB_PORT ? {} : { port }), device: device.index, leds: device.leds };
        draft.push({
          id: -1 - draft.length,
          label: (label ? (built.length === 1 ? label : `${label} · ${device.name}`) : device.name).slice(0, 64),
          address: 1, universe, profileId: profile.id, maxBrightness: 255, override: null, position: null, group: null, geometry: null,
          output,
        });
      }
      const byId = new Map(built.map(({ profile }) => [profile.id, profile as Profile]));
      const profileOf = (f: Pick<Fixture, 'profileId'>) => byId.get(f.profileId) || getProfile(f);
      const next = [...state.fixtures, ...draft];
      const problem = unitCapOverflow(next, profileOf) || ddpConflict(next, profileOf, universeOf)
        || (countUniverses(next, profileOf) > MAX_UNIVERSES
          ? `The devices at ${host} would put the patch on more than the ${MAX_UNIVERSES} universes this server transmits` : null);
      if (problem) return res.status(400).json({ ok: false, error: problem });
      for (const { profile } of built) {
        if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      }
      for (const fixture of draft) {
        fixture.id = allocateFixtureId();
        state.fixtures.push(fixture);
      }
      resizeFixtureBuffers();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, host, port, fixtures: draft, profiles: built.map(({ profile }) => profile), devices: built.map(({ device }) => device) });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  }));
}
