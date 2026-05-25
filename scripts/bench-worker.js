'use strict';

// Quick check that the persistent worker actually warms up between requests.
// Runs three analyses back-to-back through one AnalyzerWorker; the first one
// pays import + JIT + (if installed) PANNs model load. Subsequent ones should
// land much faster because everything stays resident in the Python process.

const path = require('path');
const fs = require('fs');
const AnalyzerWorker = require('../src/analyzer-worker');

const WAV = process.argv[2] || 'C:\\Users\\Tom\\AppData\\Local\\Temp\\deezer-dl-1779732820391.wav';
const DURATION = Number(process.argv[3]) || 238.0;

if (!fs.existsSync(WAV)) {
  console.error(`WAV not found: ${WAV}`);
  process.exit(1);
}

const PYTHON_EXE = require('../src/auto-show').PYTHON_EXE;
const SCRIPT = path.join(__dirname, '..', 'src', 'essentia-analyze.py');

(async () => {
  const t0 = Date.now();
  const worker = new AnalyzerWorker(PYTHON_EXE, SCRIPT);
  worker.prewarm();
  // Simulate the user spending ~10s opening the UI and connecting Spotify
  // while the worker imports librosa/torch and preloads PANNs.
  await new Promise((r) => setTimeout(r, 10000));
  console.log(`(worker had ${((Date.now()-t0)/1000).toFixed(1)}s of prewarm)`);
  try {
    for (let i = 1; i <= 3; i++) {
      const t = Date.now();
      const r = await worker.analyze(WAV, DURATION);
      const el = (Date.now() - t) / 1000;
      console.log(`run ${i}: ${el.toFixed(2)}s  bpm=${r.bpm}  segs=${r.segments.length}  genre=${r.genre?.label || 'n/a'}`);
    }
  } finally {
    worker.shutdown();
  }
})().catch((e) => { console.error(e); process.exit(1); });
