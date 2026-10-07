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
import { attachOpenRgbRoutes } from './routes/openrgb.ts';
import { attachOpsRoutes } from './routes/ops.ts';
import { attachAudioRoutes } from './routes/audio.ts';
import { attachEffectRoutes } from './routes/effects.ts';
import { attachVoiceRoutes } from './routes/voices.ts';
import { attachSequenceRoutes } from './routes/sequence.ts';

export type { RouteDeps, RouteContext } from './routes/common.ts';
export type { AnalyzeSource } from './routes/auto.ts';

function attachRoutes(app: Express, deps: RouteDeps): void {
  const ctx = routeContext(deps);
  attachLookRoutes(app, ctx);
  attachMidiRoutes(app, ctx);
  attachSourceRoutes(app, ctx);
  attachFixtureRoutes(app, ctx);
  attachOpenRgbRoutes(app, ctx);
  attachCueRoutes(app, ctx);
  attachAutoRoutes(app, ctx);
  attachWarmRoutes(app, ctx);
  attachSetupRoutes(app, ctx);
  attachOutputRoutes(app, ctx);
  attachIdentifyRoutes(app, { wled: ctx.wled, hueAreas: ctx.hueAreas, broadcast: () => ctx.integrations.broadcast() });
  attachAudioRoutes(app, ctx);
  attachEffectRoutes(app, ctx);
  attachVoiceRoutes(app, ctx);
  attachSequenceRoutes(app, ctx);
  attachOpsRoutes(app, ctx);
  // Must be registered last (see errorHandler).
  app.use(errorHandler);
}

export {
  attachRoutes,
  classifyAnalyzeSource,
  resolveLocalPath,
};
