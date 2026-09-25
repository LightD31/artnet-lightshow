import type { Express } from 'express';
import { routeContext, errorHandler } from './routes/common.ts';
import type { RouteDeps } from './routes/common.ts';
import { attachLookRoutes } from './routes/look.ts';
import { attachMidiRoutes } from './routes/midi.ts';
import { attachSourceRoutes } from './routes/sources.ts';
import { attachFixtureRoutes } from './routes/fixtures.ts';
import { attachCueRoutes } from './routes/cues.ts';
import { attachAutoRoutes, classifyAnalyzeSource, resolveLocalPath } from './routes/auto.ts';
import { attachWarmRoutes } from './routes/warm.ts';
import { attachSetupRoutes } from './routes/setup.ts';
import { attachOutputRoutes } from './routes/outputs.ts';
import { attachIdentifyRoutes } from './routes/identify.ts';
import { attachOpsRoutes } from './routes/ops.ts';

export type { RouteDeps, RouteContext } from './routes/common.ts';
export type { AnalyzeSource } from './routes/auto.ts';

/**
 * Every HTTP route, a domain to a module (src/server/routes/):
 *
 *   look       the state, the quick controls, per-fixture overrides
 *   midi       the controller's ports, mapping and learn
 *   sources    PRO DJ LINK, Spotify, the OS media session, Deezer, live input devices
 *   fixtures   profiles (GDTF, OFL, bars), WLEDs, the patch, the show file
 *   cues       the cue stack
 *   auto       analysing, running and editing the auto show; the analysis cache
 *   warm       set-list warming
 *   setup      the pre-show check, the analysis models, the settings
 *   outputs    Philips Hue, Art-Net nodes, network interfaces
 *   identify   finding the rig and making it show itself
 *   ops        the log, the server's health, restarting it
 *
 * and, last, the error handler every one of them falls through to.
 */
function attachRoutes(app: Express, deps: RouteDeps): void {
  const ctx = routeContext(deps);
  attachLookRoutes(app, ctx);
  attachMidiRoutes(app, ctx);
  attachSourceRoutes(app, ctx);
  attachFixtureRoutes(app, ctx);
  attachCueRoutes(app, ctx);
  attachAutoRoutes(app, ctx);
  attachWarmRoutes(app, ctx);
  attachSetupRoutes(app, ctx);
  attachOutputRoutes(app, ctx);
  attachIdentifyRoutes(app, { wled: ctx.wled, broadcast: () => ctx.integrations.broadcast() });
  attachOpsRoutes(app, ctx);
  // Must be registered last (see errorHandler).
  app.use(errorHandler);
}

export {
  attachRoutes,
  classifyAnalyzeSource,
  resolveLocalPath,
};
