'use strict';

/**
 * Windows "now playing" reader (System Media Transport Controls).
 *
 * Instead of integrating each streaming service's SDK, we read whatever the OS
 * reports as currently playing. Any SMTC-reporting app — Deezer, Tidal,
 * YouTube, a browser tab, a desktop player — gives us the track, play/pause
 * state, and position, with no per-service credentials.
 *
 * It spawns scripts/smtc-nowplaying.ps1 (Windows PowerShell 5.1, which still
 * has WinRT projection — pwsh 7 does not), parses its NDJSON stream, and emits
 * snapshots in the exact shape NowPlayingSource.updatePlayback() expects, so the
 * whole downstream auto-show pipeline is reused unchanged.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const RESTART_DELAY_MS = 3000;

class SmtcReader {
  constructor({ scriptPath, intervalMs = 500 } = {}) {
    this._scriptPath = scriptPath
      || path.join(__dirname, '..', 'scripts', 'smtc-nowplaying.ps1');
    this._intervalMs = intervalMs;
    this._proc = null;
    this._rl = null;
    this._restartTimer = null;
    this._stopped = false;
    this._onUpdate = null;
    this._onIdle = null;
    this._loggedError = false;
  }

  /** Called with a normalized playback snapshot on every poll with a track. */
  onUpdate(fn) { this._onUpdate = fn; }
  /** Called when nothing is playing (no active SMTC session). */
  onIdle(fn) { this._onIdle = fn; }

  /** Start reading. No-op (returns false) on non-Windows platforms. */
  start() {
    if (process.platform !== 'win32') {
      console.warn('[smtc] not on Windows — now-playing source disabled');
      return false;
    }
    this._stopped = false;
    this._spawn();
    return true;
  }

  _spawn() {
    if (this._stopped) return;

    // Use the absolute path to Windows PowerShell 5.1: `powershell.exe` on PATH
    // could resolve to pwsh on some setups, and pwsh lacks WinRT projection.
    const psExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';

    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this._scriptPath, '-IntervalMs', String(this._intervalMs),
    ];

    let proc;
    try {
      proc = spawn(psExe, args, { windowsHide: true });
    } catch (err) {
      console.warn(`[smtc] failed to spawn PowerShell: ${err.message}`);
      this._scheduleRestart();
      return;
    }
    this._proc = proc;
    proc.stdout.setEncoding('utf8');

    this._rl = readline.createInterface({ input: proc.stdout });
    this._rl.on('line', (line) => this._handleLine(line));

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => console.warn(`[smtc] PowerShell error: ${err.message}`));
    proc.on('close', (code) => {
      this._proc = null;
      if (this._stopped) return;
      const tail = stderr.trim().split('\n').slice(0, 3).join(' | ');
      console.warn(`[smtc] reader exited (code ${code})${tail ? ': ' + tail : ''} — restarting in ${RESTART_DELAY_MS / 1000}s`);
      this._scheduleRestart();
    });

    console.log('[smtc] now-playing reader started');
  }

  _scheduleRestart() {
    if (this._stopped || this._restartTimer) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._spawn();
    }, RESTART_DELAY_MS);
  }

  _handleLine(line) {
    line = line.trim();
    if (!line) return;

    let msg;
    try { msg = JSON.parse(line); }
    catch { return; } // partial/garbled line — skip

    if (!msg.ok) {
      if (!this._loggedError) {
        console.warn(`[smtc] reader reported: ${msg.error || 'unknown error'}`);
        this._loggedError = true;
      }
      return;
    }
    this._loggedError = false;

    if (!msg.title) {
      // No active session — let the source go stale on its own (paused tracks
      // still report a title, so this only fires when playback truly stops).
      if (this._onIdle) this._onIdle();
      return;
    }

    if (this._onUpdate) this._onUpdate(this._toPayload(msg));
  }

  /** Map an SMTC line to the NowPlayingSource.updatePlayback() payload shape. */
  _toPayload(msg) {
    const artist = msg.artist || '';
    const title = msg.title || '';
    return {
      // SMTC exposes no track id or ISRC, so synthesize a stable identity from
      // artist+title — enough for the source's track-change detection.
      trackId: `smtc:${artist.toLowerCase()}|${title.toLowerCase()}`,
      name: title,
      artist,
      album: msg.album || '',
      albumArt: null,
      durationMs: Number(msg.durationMs) || 0,
      progressMs: Number(msg.positionMs) || 0,
      isPlaying: !!msg.isPlaying,
      isrc: null,
      sourceApp: msg.appId || null,
    };
  }

  stop() {
    this._stopped = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._rl) { try { this._rl.close(); } catch (_) { /* ignore */ } this._rl = null; }
    if (this._proc) { try { this._proc.kill(); } catch (_) { /* ignore */ } this._proc = null; }
  }
}

module.exports = SmtcReader;
