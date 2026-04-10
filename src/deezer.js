'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const dfi = require('d-fi-core');

let initialized = false;

/**
 * Initialize the Deezer API with an ARL cookie token.
 * Must be called once before any download. No-ops on subsequent calls.
 */
async function init(arl) {
  if (initialized) return;
  if (!arl) throw new Error('DEEZER_ARL not set');
  await dfi.initDeezerApi(arl);
  initialized = true;
  console.log('[deezer] API initialized');
}

/**
 * Check whether Deezer downloads are available (ARL configured + init'd).
 */
function isAvailable() {
  return initialized;
}

/**
 * Download a track from Deezer by ISRC code.
 * Returns the path to a temporary WAV file (converted via ffmpeg).
 *
 * @param {string} trackName  – human-readable name for logs / errors
 * @param {string} isrc       – ISRC code (e.g. "USUM71820728")
 * @returns {Promise<string>} – absolute path to a temp .wav file
 */
async function downloadByIsrc(trackName, isrc) {
  // 1. Resolve ISRC → Deezer track info
  console.log(`[deezer] Looking up ISRC ${isrc} for "${trackName}"`);
  const trackInfo = await dfi.isrc2deezer(trackName, isrc);

  // 2. Get the download URL (try 320kbps MP3 first, fall back to 128kbps)
  let dlInfo;
  try {
    dlInfo = await dfi.getTrackDownloadUrl(trackInfo, 3); // MP3_320
  } catch (err) {
    if (err instanceof dfi.WrongLicense) {
      console.log('[deezer] 320kbps not available (free account), falling back to 128kbps');
      dlInfo = await dfi.getTrackDownloadUrl(trackInfo, 1); // MP3_128
    } else {
      throw err;
    }
  }

  if (!dlInfo || !dlInfo.trackUrl) {
    throw new Error(`[deezer] No download URL for "${trackName}" (ISRC: ${isrc})`);
  }

  // 3. Download the raw (possibly encrypted) audio
  console.log(`[deezer] Downloading: ${trackName} (encrypted=${dlInfo.isEncrypted})`);
  const rawBuffer = await _downloadUrl(dlInfo.trackUrl);

  // 4. Decrypt if necessary
  const audioBuffer = dlInfo.isEncrypted
    ? dfi.decryptDownload(rawBuffer, trackInfo.SNG_ID)
    : rawBuffer;

  // 5. Write to a temp MP3 file
  const basename = `deezer-dl-${Date.now()}`;
  const mp3Path = path.join(os.tmpdir(), `${basename}.mp3`);
  fs.writeFileSync(mp3Path, audioBuffer);

  // 6. Convert MP3 → WAV via ffmpeg (the analyzer expects WAV)
  const wavPath = path.join(os.tmpdir(), `${basename}.wav`);
  try {
    await _mp3ToWav(mp3Path, wavPath);
    // Clean up the intermediate MP3
    try { fs.unlinkSync(mp3Path); } catch (_) {}
    console.log(`[deezer] Ready: ${wavPath}`);
    return wavPath;
  } catch (err) {
    // Clean up on failure
    try { fs.unlinkSync(mp3Path); } catch (_) {}
    try { fs.unlinkSync(wavPath); } catch (_) {}
    throw err;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Download a URL to a Buffer. */
function _downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(_downloadUrl(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`[deezer] HTTP ${res.statusCode} downloading audio`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Convert MP3 → WAV using ffmpeg. */
function _mp3ToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-ar', '44100', '-ac', '2', '-f', 'wav',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg not found: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (exit ${code}): ${stderr}`));
      resolve(outputPath);
    });
  });
}

module.exports = { init, isAvailable, downloadByIsrc };
