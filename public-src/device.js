import { signal } from '@preact/signals';
import NoSleep from 'nosleep.js';

/**
 * What the page asks of the device it is on: stay awake, fill the screen, and
 * open even while the server is away.
 *
 * A tablet running the show that dims and locks mid-set is the rig going
 * dark in the operator's hand. The Screen Wake Lock API stops that, but only
 * on a secure page — HTTPS or localhost — and a tablet on the venue network
 * reaches the server over plain HTTP. So the lock is NoSleep's: the API where
 * the page may use it, else a muted, looping, inline video, which every
 * mobile browser keeps the screen on for.
 */

export const awakeSig = signal(false);
export const fullscreenSig = signal(false);

const AWAKE_KEY = 'lightshow.awake';
let noSleep = null;

function remember(on) {
  try { localStorage.setItem(AWAKE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

/** Keep the screen on, or let it sleep. Call from a tap or a key: the video needs one. */
export async function setAwake(on) {
  try {
    if (on) {
      noSleep = noSleep || new NoSleep();
      await noSleep.enable();
    } else if (noSleep) {
      noSleep.disable();
    }
    awakeSig.value = !!on;
  } catch {
    awakeSig.value = false;
  }
  remember(!!on);
}

export function canFullscreen() {
  return typeof document !== 'undefined' && !!document.fullscreenEnabled;
}

export function toggleFullscreen() {
  if (!canFullscreen()) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

/**
 * Once, at startup: follow fullscreen, register the app shell's service
 * worker (sw.js — only on a secure page, which is the only place a browser
 * allows one), and, if the operator left the screen kept awake, keep it
 * awake again from their first touch — the browser will not start the lock
 * without one.
 */
export function setUpDevice() {
  if (typeof document === 'undefined') return;
  document.addEventListener('fullscreenchange', () => { fullscreenSig.value = !!document.fullscreenElement; });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* the page works without it */ });
    });
  }

  let wanted = false;
  try { wanted = localStorage.getItem(AWAKE_KEY) === '1'; } catch { /* private mode */ }
  if (wanted) {
    const resume = () => {
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
      if (!awakeSig.value) setAwake(true);
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }
}
