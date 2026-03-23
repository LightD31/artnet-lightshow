'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

/**
 * Ableton Link wrapper that communicates with a Python bridge process.
 * Provides the same API surface as the old abletonlink-addon.
 */
class AbletonLink {
  constructor() {
    this._proc = null;
    this._rl = null;
    this._ready = false;
    this._enabled = false;
    this._bpm = 120;
    this._peers = 0;
    this._onTempoChange = null;
    this._onPeersChange = null;
    this._spawn();
  }

  _spawn() {
    const script = path.join(__dirname, 'link-bridge.py');
    this._proc = spawn('python', [script], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this._proc.on('error', (err) => {
      console.error(`Ableton Link bridge failed to start: ${err.message}`);
      console.error('Make sure Python 3 and aalink are installed: pip install aalink');
      this._ready = false;
    });

    this._proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Ableton Link bridge exited with code ${code}`);
      }
      this._ready = false;
    });

    this._rl = readline.createInterface({ input: this._proc.stdout });
    this._rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch (_) {}
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._ready = true;
        break;
      case 'tempo':
        this._bpm = msg.bpm;
        if (this._onTempoChange) this._onTempoChange(msg.bpm);
        break;
      case 'peers':
        this._peers = msg.peers;
        if (this._onPeersChange) this._onPeersChange(msg.peers);
        break;
      case 'status':
        this._enabled = msg.enabled;
        break;
    }
  }

  _send(obj) {
    if (this._proc && this._proc.stdin.writable) {
      this._proc.stdin.write(JSON.stringify(obj) + '\n');
    }
  }

  enable() {
    this._send({ cmd: 'enable' });
    this._enabled = true;
  }

  disable() {
    this._send({ cmd: 'disable' });
    this._enabled = false;
  }

  getTempo() {
    return this._bpm;
  }

  setTempo(bpm) {
    this._bpm = bpm;
    this._send({ cmd: 'setTempo', bpm });
  }

  getNumPeers() {
    return this._peers;
  }

  /** Register a callback for tempo changes from Link peers. */
  onTempoChange(fn) {
    this._onTempoChange = fn;
  }

  /** Register a callback for peer count changes. */
  onPeersChange(fn) {
    this._onPeersChange = fn;
  }

  /** Alias matching the old abletonlink-addon API. */
  setNumPeersCallback(fn) {
    this._onPeersChange = fn;
  }

  /** Clean shutdown. */
  destroy() {
    if (this._rl) this._rl.close();
    if (this._proc) this._proc.kill();
  }
}

module.exports = AbletonLink;
