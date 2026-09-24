// Where the end-to-end server keeps its throwaway config and cache, named
// from the port so the specs (another process) can find the analysed track it
// seeds (serve.js).

import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT) || 3999;

export const E2E_DIR = path.join(os.tmpdir(), `lightshow-e2e-${PORT}`);
export const E2E_TRACK = path.join(E2E_DIR, 'track.wav');
