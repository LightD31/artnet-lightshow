import os from 'node:os';
import { startSyncTest, resizeFixtureBuffers } from '../engine.ts';
import { hueDisconnectSchema, huePairSchema, validate } from '../validation.ts';
import * as output from '../output.ts';
import { discoverNodes } from '../artnet.ts';
import { interfaces } from '../artnet-nodes.ts';
import { discoverBridges } from '../hue.ts';
import { settings } from '../settings.ts';
import { state, placeAddresslessFixtures } from '../state.ts';
import { showStore } from '../show-store.ts';
import { messageOf } from '../../errors.ts';
import type { Express } from 'express';
import type { ArtNode } from '../artnet.ts';
import type { EntertainmentArea } from '../hue.ts';
import type { HueBridgeSettings } from '../settings.ts';
import { asyncHandler, resolveHueBridge } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * The outputs beyond a plain universe: Philips Hue (pairing, areas, the sync
 * test), the Art-Net nodes on the network, and the network interfaces sACN can
 * leave on.
 */
export function attachOutputRoutes(app: Express, ctx: RouteContext): void {
  const { applier, integrations, hueAreas, huePair } = ctx;

  // ─── Philips Hue ──────────────────────────────────────────────────────────
  // Pairing and area selection cannot be plain settings fields: the bridge
  // issues the credentials itself, and the list of areas only exists on the
  // bridge. These are the calls the Rig view drives that with. A rig can have
  // several bridges, each an entry of hue.bridges named by its id in a route;
  // the routes from before several were possible (`/api/hue/areas`…) address
  // the first one, except forgetting, which has to say which.

  /** Every bridge, what it is set up with and what its stream is doing. Never the keys. */
  app.get('/api/hue/status', (_req, res) => {
    const config = output.getHueConfig();
    const live = new Map(output.getHueStatus().map((s) => [s.id, s]));
    res.json({
      ok: true,
      latencyMs: config.latencyMs,
      bridges: config.bridges.map((b) => {
        const session = live.get(b.id);
        return {
          id: b.id,
          label: b.label,
          host: b.host,
          enabled: b.enabled,
          paired: !!(b.username && b.clientKey),
          applicationId: b.applicationId,
          area: b.entertainmentId,
          configured: !!session?.configured,
          stream: session ? session.status : 'idle',
          lastError: session ? session.error : null,
        };
      }),
    });
  });

  // Ten seconds of one white flash a second on every fixture, to film the pars
  // against the Hue lamps while setting hue.latencyMs. Every bridge gets it:
  // the flash is the show's, and every output carries the show.
  app.post('/api/hue/sync-test', (_req, res) => {
    res.json({ ok: true, seconds: startSyncTest(10) });
  });

  /**
   * The Art-Net nodes on the network. While the rig broadcasts, the server
   * keeps this list itself and sends each node its universes directly; `scan`
   * asks the network now — a fresh poll when the list is being kept, a one-off
   * on every interface when it is not (a rig sending to one node already).
   */
  app.get('/api/artnet/nodes', asyncHandler(async (req, res) => {
    const discovery = output.artnetDiscovery;
    const scan = req.query.scan === '1' || req.query.scan === 'true';
    if (scan && discovery.active) {
      discovery.pollNow();
      await new Promise((r) => setTimeout(r, 1200));
    }
    const status = discovery.status();
    let nodes: (ArtNode & { from: string; seenAt?: number })[] = status.nodes;
    let error = status.error;
    if (scan && !discovery.active) {
      const hosts = interfaces().map((i) => i.broadcast);
      if (hosts.length) {
        const found = await discoverNodes({ hosts, port: 6454, timeoutMs: 1200 });
        nodes = found.nodes;
        error = found.error;
      }
    }
    res.json({
      ok: true,
      // Whether the server is keeping the list and routing by it, or not.
      routing: status.active,
      error,
      nodes: nodes.map((n) => ({
        address: n.from || n.address,
        shortName: n.shortName,
        longName: n.longName,
        outputs: n.outputs,
        mac: n.mac,
        seenAgoMs: n.seenAt ? Math.max(0, Date.now() - n.seenAt) : 0,
      })),
    });
  }));

  // This machine's IPv4 addresses, for choosing which network sACN multicast
  // leaves on.
  app.get('/api/network/interfaces', (_req, res) => {
    res.json({ ok: true, interfaces: interfaces().map(({ name, address, netmask, broadcast }) => ({ name, address, netmask, broadcast })) });
  });

  app.get('/api/hue/discover', asyncHandler(async (_req, res) => {
    const { bridges, error } = await discoverBridges();
    // Not an error status: discovery needs internet access the show network may
    // well not have, and typing the IP in is a perfectly normal path.
    res.json({ ok: true, bridges, error });
  }));

  /**
   * Pair with a bridge and store what it issues, as a bridge of its own.
   *
   * The link button has to have been pressed in the last 30 seconds, so the
   * "press it and try again" answer is an ordinary outcome rather than a
   * failure — the page reports it and lets the operator retry. Pairing a
   * bridge that is already in the list again (its keys were lost, or it was
   * unlinked in the Hue app) replaces its keys rather than adding a twin: a
   * bridge is where it is.
   */
  app.post('/api/hue/pair', asyncHandler(async (req, res) => {
    const { host, label } = validate(huePairSchema, req.body || {}, 'hue pair');
    const result = await huePair(host, { label: os.hostname() });
    if (!result.ok) {
      return res.status(result.pressLink ? 409 : 502)
        .json({ ok: false, error: result.error, pressLink: !!result.pressLink });
    }

    const bridges = settings.group('hue').bridges;
    const existing = bridges.find((b) => b.host === host) || null;
    const entry: HueBridgeSettings = {
      id: existing ? existing.id : nextBridgeId(bridges),
      label: label || (existing ? existing.label : '') || host,
      // A bridge that has just been paired is meant to be used; it still does
      // nothing until an area is picked and a lamp of it is in the patch.
      enabled: existing ? existing.enabled : true,
      host,
      username: result.username,
      clientKey: result.clientKey,
      applicationId: result.applicationId || '',
      entertainmentId: existing ? existing.entertainmentId : '',
    };
    const changed = settings.update({
      hue: { bridges: existing ? bridges.map((b) => (b.id === entry.id ? entry : b)) : [...bridges, entry] },
    });
    applier.applyChanged(changed);

    // Hand back the areas straight away: pairing is only ever done in order to
    // pick one, and a second round trip here just adds a step to the setup.
    let areas: EntertainmentArea[] = [];
    let areasError: string | null = null;
    try {
      areas = await hueAreas(host, result.username);
    } catch (err) {
      areasError = messageOf(err);
    }
    res.json({ ok: true, bridge: { id: entry.id, label: entry.label, host }, host, areas, areasError });
  }));

  /** The entertainment areas on a paired bridge, with their channel ids. */
  app.get(['/api/hue/areas', '/api/hue/:bridge/areas'], asyncHandler(async (req, res) => {
    const bridge = resolveHueBridge(req, res);
    if (!bridge) return;
    if (!bridge.host || !bridge.username) {
      return res.status(409).json({ ok: false, error: `Pair with "${bridge.label || bridge.id}" first.` });
    }
    try {
      const areas = await hueAreas(bridge.host, bridge.username);
      res.json({ ok: true, bridge: { id: bridge.id, label: bridge.label }, areas });
    } catch (err) {
      res.status(502).json({ ok: false, error: messageOf(err) });
    }
  }));

  /**
   * Forget a bridge: its entry goes, keys and all, and its stream with it.
   *
   * Its lamps in the patch would be left naming a bridge that is not there,
   * so it refuses while there are any — unless asked to take them along
   * (`removeFixtures`), which removes them as DELETE /api/fixtures/:id would.
   * The application key stays registered on the bridge itself — Hue offers
   * no way to revoke it from here, so that is done in the Hue app under
   * linked devices.
   */
  app.post('/api/hue/:bridge/disconnect', (req, res) => {
    try {
      const body = validate(hueDisconnectSchema, req.body || {}, 'hue disconnect');
      const bridge = resolveHueBridge(req, res);
      if (!bridge) return;
      const name = bridge.label || bridge.id;
      const lamps = state.fixtures.filter((f) => f.output?.protocol === 'hue' && f.output.bridge === bridge.id);
      if (lamps.length && !body.removeFixtures) {
        return res.status(409).json({
          ok: false,
          error: `${lamps.length} lamp${lamps.length === 1 ? '' : 's'} of "${name}" ${lamps.length === 1 ? 'is' : 'are'} in the patch: `
            + `${lamps.map((f) => `"${f.label}"`).join(', ')}. Remove ${lamps.length === 1 ? 'it' : 'them'} first, or forget the bridge with its lamps.`,
          fixtures: lamps.map((f) => f.id),
        });
      }
      if (lamps.length && lamps.length >= state.fixtures.length) {
        return res.status(400).json({ ok: false, error: 'Must have at least one fixture: add another before forgetting this bridge with its lamps.' });
      }
      if (lamps.length) {
        const gone = new Set(lamps.map((f) => f.id));
        for (let i = state.fixtures.length - 1; i >= 0; i--) {
          if (gone.has(state.fixtures[i].id)) state.fixtures.splice(i, 1);
        }
        placeAddresslessFixtures();
        resizeFixtureBuffers();
        showStore.scheduleSave();
      }
      const changed = settings.update({ hue: { bridges: settings.group('hue').bridges.filter((b) => b.id !== bridge.id) } });
      applier.applyChanged(changed);
      integrations.broadcast();
      res.json({ ok: true, removed: lamps.map((f) => f.id) });
    } catch (err) {
      res.status(400).json({ ok: false, error: messageOf(err) });
    }
  });

  // Forgetting has to say which bridge: with several, "the bridge" is nobody.
  app.post('/api/hue/disconnect', (_req, res) => {
    res.status(400).json({ ok: false, error: 'Name the bridge: POST /api/hue/:bridge/disconnect — GET /api/hue/status lists them.' });
  });
}

/** The next free id: bridge-1 first (the migrated one's), then up. */
function nextBridgeId(bridges: readonly { id: string }[]): string {
  const taken = new Set(bridges.map((b) => b.id));
  for (let n = 1; ; n++) {
    const id = `bridge-${n}`;
    if (!taken.has(id)) return id;
  }
}
