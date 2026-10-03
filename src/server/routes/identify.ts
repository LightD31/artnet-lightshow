import net from 'node:net';
import { z } from 'zod';

import { state, universeOf, wireUniverses } from '../state.ts';
import { getProfile } from '../profiles.ts';
import { identify as engineIdentify } from '../engine.ts';
import { fixturesOnUniverses, identifySeconds, createPixelIdentify } from '../identify.ts';
import { createSacnWatch } from '../sacn-watch.ts';
import { sendArtAddress, AC_LED_LOCATE, AC_LED_NORMAL } from '../artnet.ts';
import { resolveCid } from '../sacn.ts';
import { sendDdp } from '../ddp.ts';
import { identifyDevices, listEntertainmentConfigs } from '../hue.ts';
import { OPENRGB_PORT } from '../openrgb.ts';
import { createOpenRgbIdentify } from '../openrgb-devices.ts';
import { openrgbOutputOf } from '../openrgb-routes.ts';
import * as output from '../output.ts';
import { validate } from '../validation.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express, Response } from 'express';
import { asyncHandler, resolveHueBridge } from './common.ts';
import type { Identify, PixelSend } from '../identify.ts';
import type { SacnWatch } from '../sacn-watch.ts';
import type { WledClient } from '../wled.ts';

/**
 * Finding the rig on the network and making it show itself.
 *
 *   POST /api/identify            fixtures (by id) or everything on some
 *                                 universes flash their identify picture
 *   POST /api/identify/stop
 *   POST /api/artnet/identify     an Art-Net node's own locate LEDs, and the
 *                                 fixtures on the universes it outputs
 *   GET  /api/sacn/sources        the other sACN sources on the network, and
 *                                 any universe one of them shares with the rig
 *   POST /api/wled/identify       a WLED: through the patch when it is in it,
 *                                 else streamed its picture directly
 *   POST /api/openrgb/identify    an OpenRGB device: the same, over the SDK
 *   POST /api/hue/identify        a Hue channel: through its lamp in the
 *                                 patch, else the bridge's own identify
 */

export interface IdentifyRouteDeps {
  wled: WledClient;
  /** Tell the pages: the patch or what identifies changed. */
  broadcast: () => void;
  /** Stand-ins for tests; the running server's own otherwise. */
  identify?: Identify;
  sacnWatch?: SacnWatch;
  sendPixels?: PixelSend;
  openrgbIdentify?: ReturnType<typeof createOpenRgbIdentify>;
  locate?: typeof sendArtAddress;
  hueIdentify?: typeof identifyDevices;
  hueAreas?: typeof listEntertainmentConfigs;
}

const IPV4_OR_HOST = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const seconds = z.number().finite().min(0).max(3600).optional();

const identifySchema = z.object({
  fixtures: z.array(z.number().int().min(0)).max(1024).optional(),
  universes: z.array(z.number().int().min(0).max(32767)).max(256).optional(),
  seconds,
}).strict();

const artnetIdentifySchema = z.object({
  address: z.string().refine((v) => net.isIPv4(v), 'must be an IPv4 address'),
  // What the list the page shows said this node outputs, for a node the
  // server is not keeping track of (found by a one-off scan).
  universes: z.array(z.number().int().min(0).max(32767)).max(64).optional(),
  seconds,
}).strict();

const wledIdentifySchema = z.object({
  host: z.string().regex(IPV4_OR_HOST, 'is not a hostname or an IPv4 address'),
  seconds,
}).strict();

const openrgbIdentifySchema = z.object({
  host: z.string().regex(IPV4_OR_HOST, 'is not a hostname or an IPv4 address'),
  port: z.number().int().min(1).max(65535).optional(),
  device: z.number().int().min(0).max(4095),
  seconds,
}).strict();

const hueIdentifySchema = z.object({
  channel: z.number().int().min(0).max(255),
  seconds,
}).strict();

/** What a failed request answers: its own status when it has one. */
function fail(res: Response, err: unknown, fallback = 400): void {
  res.status(statusOf(err) || fallback).json({ ok: false, error: messageOf(err) });
}

const profileOf = (f: { profileId: string }) => getProfile(f);

function attachIdentifyRoutes(app: Express, deps: IdentifyRouteDeps): void {
  const identify = deps.identify || engineIdentify;
  const watch = deps.sacnWatch || createSacnWatch();
  const pixels = createPixelIdentify({ send: deps.sendPixels || ((target, data) => sendDdp(target, data)) });
  const openrgbPixels = deps.openrgbIdentify || createOpenRgbIdentify();
  const locate = deps.locate || sendArtAddress;
  const hueIdentify = deps.hueIdentify || identifyDevices;
  const hueAreas = deps.hueAreas || listEntertainmentConfigs;
  // Per node: when its locate LEDs go back to normal.
  const unlocate = new Map<string, ReturnType<typeof setTimeout>>();

  /** Start identify on these fixtures, or stop it for none; what the pages are told. */
  const start = (ids: number[], secs: number) => identify.start(ids, secs);

  app.post('/api/identify', (req, res) => {
    try {
      const body = validate(identifySchema, req.body || {}, 'identify');
      const secs = identifySeconds(body.seconds);
      const known = new Set(state.fixtures.map((f) => f.id));
      const ids = (body.fixtures || []).filter((id) => known.has(id));
      if (body.universes && body.universes.length) {
        ids.push(...fixturesOnUniverses(state.fixtures, body.universes, profileOf, universeOf));
      }
      if (body.fixtures && body.fixtures.length && !ids.length && !(body.universes && body.universes.length)) {
        return res.status(404).json({ ok: false, error: 'That fixture is not in the patch' });
      }
      res.json({ ok: true, ...start(ids, secs) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/identify/stop', (_req, res) => {
    identify.stop();
    pixels.stopAll();
    openrgbPixels.stopAll();
    res.json({ ok: true });
  });

  app.post('/api/artnet/identify', asyncHandler(async (req, res) => {
    try {
      const body = validate(artnetIdentifySchema, req.body || {}, 'Art-Net identify');
      const secs = identifySeconds(body.seconds);
      const node = output.artnetDiscovery.status().nodes.find((n) => (n.from || n.address) === body.address);
      const outputs = node ? node.outputs : (body.universes || []);
      const sent = await locate({ host: body.address, command: secs > 0 ? AC_LED_LOCATE : AC_LED_NORMAL, bindIndex: node?.bindIndex || 1 });
      clearTimeout(unlocate.get(body.address));
      unlocate.delete(body.address);
      if (secs > 0 && sent.ok) {
        const timer = setTimeout(() => {
          unlocate.delete(body.address);
          locate({ host: body.address, command: AC_LED_NORMAL, bindIndex: node?.bindIndex || 1 }).catch(() => {});
        }, secs * 1000);
        timer.unref();
        unlocate.set(body.address, timer);
      }
      const ids = fixturesOnUniverses(state.fixtures, outputs, profileOf, universeOf);
      const status = ids.length ? start(ids, secs) : identify.status();
      res.json({ ok: true, located: sent.ok, locateError: sent.error, outputs, ...status, fixtures: ids });
    } catch (err) {
      fail(res, err);
    }
  }));

  app.get('/api/sacn/sources', (req, res) => {
    const config = output.getSacnConfig();
    // The universes this rig puts out as sACN, whether sACN is on or not:
    // the question is also "would turning it on clash with a console".
    const ours = new Map<number, number>();
    for (const universe of wireUniverses()) {
      const mapped = output.sacnUniverseFor(universe, config.universeOffset);
      if (mapped !== null) ours.set(mapped, universe);
    }
    if (req.query.listen === '1' || req.query.listen === 'true') {
      const secs = Math.max(1, Math.min(30, Number(req.query.seconds) || 12));
      watch.listen({
        seconds: secs,
        universes: [...ours.keys()],
        ownCid: resolveCid(config.cid).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
        iface: config.interface || '',
      });
    }
    const status = watch.status();
    res.json({
      ok: true,
      enabled: config.enabled,
      ...status,
      conflicts: status.conflicts
        .filter((c) => ours.has(c.universe))
        .map((c) => ({ ...c, rigUniverse: ours.get(c.universe) })),
    });
  });

  app.post('/api/wled/identify', asyncHandler(async (req, res) => {
    try {
      const body = validate(wledIdentifySchema, req.body || {}, 'WLED identify');
      const secs = identifySeconds(body.seconds);
      const host = body.host.toLowerCase();
      // Every fixture it is: all of it, or each of its segments.
      const patched = state.fixtures.filter((f) => f.output?.protocol === 'ddp' && f.output.host.toLowerCase() === host);
      if (patched.length) {
        pixels.stop(body.host);
        return res.json({ ok: true, via: 'patch', ...start(patched.map((f) => f.id), secs) });
      }
      const info = await deps.wled.info(body.host);
      pixels.start(body.host, info, secs);
      res.json({ ok: true, via: 'device', leds: info.leds, ids: [], remainingMs: secs * 1000 });
    } catch (err) {
      fail(res, err);
    }
  }));

  app.post('/api/openrgb/identify', asyncHandler(async (req, res) => {
    try {
      const body = validate(openrgbIdentifySchema, req.body || {}, 'OpenRGB identify');
      const secs = identifySeconds(body.seconds);
      const port = body.port ?? OPENRGB_PORT;
      const host = body.host.toLowerCase();
      const patched = state.fixtures.filter((f) => {
        const output = openrgbOutputOf(f);
        return output && output.host.toLowerCase() === host && (output.port ?? OPENRGB_PORT) === port && output.device === body.device;
      });
      if (patched.length) {
        openrgbPixels.stop(body.host, port, body.device);
        return res.json({ ok: true, via: 'patch', ...start(patched.map((f) => f.id), secs) });
      }
      const { leds, name } = await openrgbPixels.start(body.host, port, body.device, secs);
      res.json({ ok: true, via: 'device', leds, name, ids: [], remainingMs: leds ? secs * 1000 : 0 });
    } catch (err) {
      fail(res, err, 502);
    }
  }));

  // A channel of one bridge's area; the route from before several bridges
  // were possible means the first one.
  app.post(['/api/hue/identify', '/api/hue/:bridge/identify'], asyncHandler(async (req, res) => {
    try {
      const body = validate(hueIdentifySchema, req.body || {}, 'Hue identify');
      const secs = identifySeconds(body.seconds);
      const bridge = resolveHueBridge(req, res);
      if (!bridge) return;
      if (!bridge.host || !bridge.username) return res.status(409).json({ ok: false, error: `Pair with "${bridge.label || bridge.id}" first.` });
      const lamp = state.fixtures.find((f) => f.output?.protocol === 'hue' && f.output.bridge === bridge.id && f.output.channel === body.channel);
      if (lamp) return res.json({ ok: true, via: 'fixture', ...start([lamp.id], secs) });
      const areas = await hueAreas(bridge.host, bridge.username);
      const area = areas.find((a) => a.id === bridge.entertainmentId) || null;
      const channel = area ? area.channels.find((c) => c.id === body.channel) : null;
      if (!channel) return res.status(404).json({ ok: false, error: `Channel ${body.channel} is not in the entertainment area of "${bridge.label || bridge.id}"` });
      const lamps = secs > 0 ? await hueIdentify(bridge.host, bridge.username, channel.devices || []) : 0;
      res.json({ ok: true, via: 'bridge', lamps });
    } catch (err) {
      fail(res, err, 502);
    }
  }));

  // Tell every page what is identifying, when it starts and when it ends.
  identify.onChange(() => deps.broadcast());
}

export { attachIdentifyRoutes };
