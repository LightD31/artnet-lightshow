import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { messageOf } from './errors.ts';
import { ffmpegCommand } from './tools.ts';

const KNOWN_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.aac', '.alac', '.aiff', '.aif', '.wma', '.opus']);

async function toWav(inputPath: string, outputPath: string): Promise<string> {
  const ffmpeg = await ffmpegCommand();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
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

async function audioToTempWav(data: Uint8Array, fileName: string): Promise<string> {
  const ext = path.extname(fileName || '').toLowerCase();
  const id = randomUUID();
  const original = path.join(os.tmpdir(), `lightshow-audio-${id}${KNOWN_EXTENSIONS.has(ext) ? ext : ''}`);
  const wav = path.join(os.tmpdir(), `lightshow-audio-${id}-decoded.wav`);
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
