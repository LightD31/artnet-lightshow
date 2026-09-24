// The server the end-to-end tests drive: the real one, on its own port, with
// its own throwaway config directory, and no output — a test run on a laptop
// on the venue network must not light the rig, and must not touch the show
// saved in config/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const E2E_PORT = Number(process.env.E2E_PORT) || 3999;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-e2e-'));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
  server: { host: '127.0.0.1', port: E2E_PORT, token: '' },
  artnet: { enabled: false },
  sacn: { enabled: false },
  sources: { prolink: false, smtc: false },
}, null, 2));
process.env.LIGHTSHOW_CONFIG_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

await import('../../server.js');
