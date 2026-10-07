import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto, { randomUUID } from 'node:crypto';
import { toWav } from './audio-file.ts';
import { messageOf } from './errors.ts';

/**
 * Deezer, as an optional plugin: tracks by ISRC through d-fi-core, with an ARL
 * from the operator's own account.
 *
 * Nothing of it is loaded until an ARL is set — d-fi-core is imported the
 * first time it is needed, and is an optional dependency. Deezer's audio is
 * encrypted with Blowfish, which OpenSSL 3 keeps in its legacy provider:
 * rather than every run of the server carrying that, the supervisor turns it
 * on only when an ARL is set (supervisor.ts). A server started without it —
 * the ARL added since, or run without the supervisor — says Deezer needs a
 * restart, and fetches tracks with yt-dlp meanwhile.
 *
 * Downloading from Deezer this way is against its terms of use; the ARL is
 * the operator's, and so is the choice.
 */

type Dfi = typeof import('d-fi-core');
let dfi: Dfi | null = null;

/** d-fi-core, loaded the first time Deezer is used. */
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

/** Whether this server can decrypt Deezer's audio: Blowfish, from OpenSSL's legacy provider. */
function canDecrypt(): boolean {
  try {
    crypto.createDecipheriv('bf-cbc', Buffer.alloc(16), Buffer.alloc(8));
    return true;
  } catch (_) {
    return false;
  }
}

// Bounds on the audio download. Previously unbounded on all three counts: a
// redirect loop recursed until it blew the stack, a stalled connection hung
// forever, and the whole body accumulated in memory with no ceiling.
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;   // a 320 kbps hour is ~144 MB; tracks are far smaller

let initialized = false;

/**
 * Initialize the Deezer API with an ARL cookie token.
 * Must be called once before any download. No-ops on subsequent calls.
 */
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

/**
 * Whether Deezer downloads are available: an ARL, signed in, and the means to
 * decrypt what comes down.
 */
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
  // 1. Resolve ISRC → Deezer track info
  const dfi = await lib();
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

  // 5. Write to a temp MP3 file. Random rather than timestamped, so two
  // prefetches started in the same millisecond cannot share a file; and
  // written asynchronously, because a synchronous write of a whole track
  // stalls the render loop that shares this thread.
  const basename = `deezer-dl-${randomUUID()}`;
  const mp3Path = path.join(os.tmpdir(), `${basename}.mp3`);
  await fs.promises.writeFile(mp3Path, audioBuffer);

  // 6. Convert MP3 → WAV via ffmpeg (the analyzer expects WAV)
  const wavPath = path.join(os.tmpdir(), `${basename}.wav`);
  try {
    await toWav(mp3Path, wavPath);
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

/** Download a URL to a Buffer, with a redirect cap, timeout and size ceiling. */
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

      // Trust the declared length when present, but still enforce the ceiling
      // as bytes arrive — content-length is advisory.
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
