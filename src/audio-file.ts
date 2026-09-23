import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { messageOf } from './errors.ts';

/**
 * Audio from elsewhere, made into what the analyser reads best: a WAV file in
 * the temp folder. The analyser can open most formats itself, but not all of
 * what a DJ's USB stick holds (AIFF with odd chunks, ALAC in an .m4a), and a
 * conversion here fails loudly and early rather than halfway into a model.
 */

// What a file's own name may contribute to a temp file's: its extension, if it
// is one of these, which ffmpeg then trusts over its own guess.
const KNOWN_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.aac', '.alac', '.aiff', '.aif', '.wma', '.opus']);

/** Convert any audio file ffmpeg can read to a 44.1 kHz stereo WAV. */
function toWav(inputPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-vn', '-ar', '44100', '-ac', '2', '-f', 'wav',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    proc.on('error', (err) => reject(new Error(`ffmpeg not found: ${messageOf(err)}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim()}`));
      resolve(outputPath);
    });
  });
}

/**
 * Write `data`, an audio file called `fileName` somewhere else, to a temp WAV
 * and return its path. The caller removes it.
 */
async function audioToTempWav(data: Uint8Array, fileName: string): Promise<string> {
  const ext = path.extname(fileName || '').toLowerCase();
  const id = randomUUID();
  const original = path.join(os.tmpdir(), `lightshow-audio-${id}${KNOWN_EXTENSIONS.has(ext) ? ext : ''}`);
  const wav = path.join(os.tmpdir(), `lightshow-audio-${id}-decoded.wav`);
  // Async: a lossless file is tens of megabytes, and a synchronous write that
  // size stalls the event loop the Art-Net frames go out on.
  await fsp.writeFile(original, data);
  try {
    return await toWav(original, wav);
  } catch (err) {
    await fsp.unlink(wav).catch(() => {});
    throw err;
  } finally {
    await fsp.unlink(original).catch(() => {});
  }
}

export { toWav, audioToTempWav };
