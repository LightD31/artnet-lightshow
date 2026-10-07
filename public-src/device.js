import { signal } from '@preact/signals';
import NoSleep from 'nosleep.js';

// NoSleep provides a video fallback because venue HTTP pages cannot use the Wake Lock API.

export const awakeSig = signal(false);
export const fullscreenSig = signal(false);

const AWAKE_KEY = 'lightshow.awake';
let noSleep = null;

function remember(on) {
  try { localStorage.setItem(AWAKE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

// Call from a user gesture because the fallback video cannot autoplay.
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

// Resume a saved wake lock on the first gesture because browsers require user activation.
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
