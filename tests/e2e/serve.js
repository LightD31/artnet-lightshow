// The server the end-to-end tests drive: the real one, on its own port, with
// its own throwaway config directory, and no output — a test run on a laptop
// on the venue network must not light the rig, and must not touch the show
// saved in config/.
//
// Its analysis cache is throwaway too, and holds one analysed track: a stand-in
// audio file at E2E_TRACK whose analysis is already cached, so a spec can load
// a track (POST /api/auto/analyze with that path) and read, rehearse and edit
// its show without Python.

import fs from 'node:fs';
import path from 'node:path';
import { E2E_DIR, E2E_TRACK } from './paths.js';
import { AnalysisCache, keyForLocalFile } from '../../src/analysis-cache.ts';

export const E2E_PORT = Number(process.env.E2E_PORT) || 3999;

fs.rmSync(E2E_DIR, { recursive: true, force: true });
fs.mkdirSync(E2E_DIR);
fs.writeFileSync(path.join(E2E_DIR, 'settings.json'), JSON.stringify({
  server: { host: '127.0.0.1', port: E2E_PORT, token: '' },
  artnet: { enabled: false },
  sacn: { enabled: false },
  sources: { prolink: false, smtc: false },
}, null, 2));
process.env.LIGHTSHOW_CONFIG_DIR = E2E_DIR;
process.env.LIGHTSHOW_CACHE_DIR = path.join(E2E_DIR, 'cache');
process.env.LIGHTSHOW_LOG_DIR = path.join(E2E_DIR, 'logs');
// The server itself, not a supervisor over it: the specs drive one process.
process.env.LIGHTSHOW_SUPERVISOR = '0';

const document = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'tracks', 'p-nk-try.json'), 'utf8'));
fs.writeFileSync(E2E_TRACK, 'not audio: its analysis is cached');
await new AnalysisCache(path.join(process.env.LIGHTSHOW_CACHE_DIR, 'analysis'))
  .save(keyForLocalFile(E2E_TRACK), document, { track: document.track });

process.on('exit', () => fs.rmSync(E2E_DIR, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

await import('../../server.js');
