import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto, { randomUUID } from 'node:crypto';
import { toWav } from './audio-file.ts';
import { messageOf } from './errors.ts';

type Dfi = typeof import('d-fi-core');
let dfi: Dfi | null = null;

async function lib(): Promise<Dfi> {
  if (!dfi) {
    try {
      dfi = await import('d-fi-core');
    } catch (err) {
      throw new Error(`Deezer support is not installed (d-fi-core: ${messageOf(err)}) — run npm install`, { cause: err });
    }
  }
  return dfi;
}

function canDecrypt(): boolean {
  try {
    crypto.createDecipheriv('bf-cbc', Buffer.alloc(16), Buffer.alloc(8));
    return true;
  } catch (_) {
    return false;
  }
}

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;   // a 320 kbps hour is ~144 MB; tracks are far smaller

let initialized = false;

async function init(arl: string): Promise<void> {
  if (initialized) return;
  if (!arl) throw new Error('No Deezer ARL set');
  await (await lib()).initDeezerApi(arl);
  initialized = true;
  console.log('[deezer] API initialized');
  if (!canDecrypt()) {
    console.warn('[deezer] this server was started without OpenSSL\'s legacy provider, which Deezer\'s downloads need: '
      + 'restart it (Settings → Restart now) — until then, tracks come from yt-dlp');
  }
}

function isAvailable(): boolean {
  return initialized && canDecrypt();
}

/**
 * Download a track from Deezer by ISRC code.
 * Returns the path to a temporary WAV file (converted via ffmpeg).
 *
 * @param {string} trackName  – human-readable name for logs / errors
 * @param {string} isrc       – ISRC code (e.g. "USUM71820728")
 * @returns {Promise<string>} – absolute path to a temp .wav file
 */
async function downloadByIsrc(trackName: string, isrc: string): Promise<string> {
  const dfi = await lib();
  console.log(`[deezer] Looking up ISRC ${isrc} for "${trackName}"`);
  const trackInfo = await dfi.isrc2deezer(trackName, isrc);

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

  console.log(`[deezer] Downloading: ${trackName} (encrypted=${dlInfo.isEncrypted})`);
  const rawBuffer = await _downloadUrl(dlInfo.trackUrl);

  const audioBuffer = dlInfo.isEncrypted
    ? dfi.decryptDownload(rawBuffer, trackInfo.SNG_ID)
    : rawBuffer;

  const basename = `deezer-dl-${randomUUID()}`;
  const mp3Path = path.join(os.tmpdir(), `${basename}.mp3`);
  await fs.promises.writeFile(mp3Path, audioBuffer);

  const wavPath = path.join(os.tmpdir(), `${basename}.wav`);
  try {
    await toWav(mp3Path, wavPath);
    try { fs.unlinkSync(mp3Path); } catch (_) {}
    console.log(`[deezer] Ready: ${wavPath}`);
    return wavPath;
  } catch (err) {
    try { fs.unlinkSync(mp3Path); } catch (_) {}
    try { fs.unlinkSync(wavPath); } catch (_) {}
    throw err;
  }
}

function _downloadUrl(url: string, redirectsLeft = MAX_REDIRECTS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();                       // drain so the socket can be reused
        if (redirectsLeft <= 0) {
          return reject(new Error(`[deezer] too many redirects (>${MAX_REDIRECTS}) downloading audio`));
        }
        const next = new URL(res.headers.location, url).toString();
        return resolve(_downloadUrl(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`[deezer] HTTP ${res.statusCode} downloading audio`));
      }

      const declared = Number.parseInt(res.headers['content-length'] ?? '', 10);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        res.destroy();
        return reject(new Error(
          `[deezer] audio too large (${Math.round(declared / 1024 / 1024)} MB, limit `
          + `${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB)`
        ));
      }

      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          res.destroy();
          reject(new Error(
            `[deezer] audio exceeded ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB limit`
          ));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`[deezer] download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

export {
  init,
  isAvailable,
  canDecrypt,
  downloadByIsrc,
};
