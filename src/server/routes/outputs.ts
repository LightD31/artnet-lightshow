import os from 'node:os';
import { startSyncTest } from '../engine.ts';
import { huePairSchema, validate } from '../validation.ts';
import * as output from '../output.ts';
import { discoverNodes } from '../artnet.ts';
import { interfaces } from '../artnet-nodes.ts';
import { discoverBridges, pair as pairBridge, listEntertainmentConfigs } from '../hue.ts';
import { settings } from '../settings.ts';
import { messageOf } from '../../errors.ts';
import type { Express } from 'express';
import type { ArtNode } from '../artnet.ts';
import type { EntertainmentArea } from '../hue.ts';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * The outputs beyond a plain universe: Philips Hue (pairing, areas, the sync
 * test), the Art-Net nodes on the network, and the network interfaces sACN can
 * leave on.
 */
export function attachOutputRoutes(app: Express, ctx: RouteContext): void {
  const { applier } = ctx;

  // ─── Philips Hue ──────────────────────────────────────────────────────────
  // Pairing and area selection cannot be plain settings fields: the bridge
  // issues the credentials itself, and the list of areas only exists on the
  // bridge. These are the calls the Rig view drives that with.

  app.get('/api/hue/status', (_req, res) => {
    const config = output.getHueConfig();
    res.json({
      ok: true,
      status: output.getHueStatus(),
      // Never the credentials — only whether we have them.
      paired: !!(config.username && config.clientKey),
      host: config.host,
      entertainmentId: config.entertainmentId,
    });
  });

  // Ten seconds of one white flash a second on every fixture, to film the pars
  // against the Hue lamps while setting hue.latencyMs.
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
   * Pair with a bridge and store what it issues.
   *
   * The link button has to have been pressed in the last 30 seconds, so the
   * "press it and try again" answer is an ordinary outcome rather than a
   * failure — the page reports it and lets the operator retry.
   */
  app.post('/api/hue/pair', asyncHandler(async (req, res) => {
    const { host } = validate(huePairSchema, req.body || {}, 'hue pair');
    const result = await pairBridge(host, { label: os.hostname() });
    if (!result.ok) {
      return res.status(result.pressLink ? 409 : 502)
        .json({ ok: false, error: result.error, pressLink: !!result.pressLink });
    }

    const changed = settings.update({
      hue: {
        host,
        username: result.username,
        clientKey: result.clientKey,
        applicationId: result.applicationId || '',
      },
    });
    applier.applyChanged(changed);

    // Hand back the areas straight away: pairing is only ever done in order to
    // pick one, and a second round trip here just adds a step to the setup.
    let areas: EntertainmentArea[] = [];
    let areasError: string | null = null;
    try {
      areas = await listEntertainmentConfigs(host, result.username);
    } catch (err) {
      areasError = messageOf(err);
    }
    res.json({ ok: true, host, areas, areasError });
  }));

  /** The entertainment areas on the paired bridge, with their channel ids. */
  app.get('/api/hue/areas', asyncHandler(async (_req, res) => {
    const config = output.getHueConfig();
    if (!config.host || !config.username) {
      return res.status(409).json({ ok: false, error: 'Pair with a bridge first.' });
    }
    try {
      const areas = await listEntertainmentConfigs(config.host, config.username);
      res.json({ ok: true, areas });
    } catch (err) {
      res.status(502).json({ ok: false, error: messageOf(err) });
    }
  }));

  /**
   * Forget the bridge.
   *
   * Clears the credentials and turns the output off, because leaving it enabled
   * with nothing to connect to would have the render loop retrying a bridge the
   * operator has just said they are done with. The application key stays
   * registered on the bridge itself — Hue offers no way to revoke it from here,
   * so that is done in the Hue app under linked devices.
   */
  app.post('/api/hue/disconnect', (_req, res) => {
    try {
      const changed = settings.update({
        hue: {
          enabled: false, host: '', username: '', clientKey: '', applicationId: '',
          entertainmentId: '',
        },
      });
      applier.applyChanged(changed);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: messageOf(err) });
    }
  });
}
