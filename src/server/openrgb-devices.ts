import { MAX_CELLS_PER_FIXTURE } from '../shared/rig.ts';
import { HttpError } from '../errors.ts';
import { identifyPixels } from './identify.ts';
import { OPENRGB_PORT, OpenRgbConnection, openrgbConnectionKey, openrgbHttpError } from './openrgb.ts';
import type { ControllerData, OpenRgbDevice } from './openrgb.ts';
import { profileSchema, validate } from './validation.ts';
import type { ProfileInput } from './validation.ts';
import type { ProfileCell } from '../types/rig.ts';

/**
 * An OpenRGB device as a fixture: the profile it is patched on, and identify
 * for one that is not in the patch yet. Apart from openrgb.ts, which the
 * engine's worker loads with the transmitter, so that the schemas here stay
 * out of its startup.
 */

// A device driven directly is sent its identify picture at this rate (identify.ts).
const PIXEL_FRAME_MS = 33;

/** The profile id a device at `host` gets, so the same device is found again. */
function openrgbProfileId(host: string, port: number, index: number): string {
  return `openrgb-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${port === OPENRGB_PORT ? '' : `-${port}`}-${index}`.slice(0, 128);
}

/**
 * The profile for a device: its LEDs as cells of red, green and blue, one
 * after another, as a WLED strip's are — one light when it has one LED.
 * Throws a 400 for one the engine cannot take.
 */
function openrgbProfile(device: Pick<OpenRgbDevice, 'index' | 'name' | 'type' | 'leds'>, host: string, port = OPENRGB_PORT): ProfileInput {
  const { leds } = device;
  if (leds < 1) throw new HttpError(400, `${device.name} reports no LEDs`);
  if (leds > MAX_CELLS_PER_FIXTURE) throw new HttpError(400, `${device.name} has ${leds} LEDs; a fixture takes up to ${MAX_CELLS_PER_FIXTURE}`);
  const mapOf = (c: number) => ({ red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 });
  const profile = {
    id: openrgbProfileId(host, port, device.index),
    name: device.name.slice(0, 128),
    manufacturer: 'OpenRGB',
    modeName: `${leds} ${leds === 1 ? 'LED' : 'LEDs'}, RGB${device.type && device.type !== 'Unknown' ? `, ${device.type}` : ''}`,
    channelCount: leds * 3,
    channelMap: leds === 1 ? mapOf(0) : {},
    ...(leds > 1 ? { cells: Array.from({ length: leds }, (_, c): ProfileCell => ({ channelMap: mapOf(c) })) } : {}),
  };
  return validate(profileSchema, profile, 'OpenRGB profile');
}

/**
 * Identify for a device that is not in the patch: the picture a WLED gets
 * (identify.ts) streamed to it for `seconds` over a connection of its own,
 * then its colours and its mode put back as they were found.
 */
function createOpenRgbIdentify({ connect = (host: string, port: number) => new OpenRgbConnection({ host, port, reconnect: false }),
  clock = () => performance.now(), every = setInterval, stopEvery = clearInterval }: {
  connect?: (host: string, port: number) => OpenRgbConnection;
  clock?: () => number;
  every?: (fn: () => void, ms: number) => unknown;
  stopEvery?: (handle: never) => void;
} = {}) {
  const running = new Map<string, () => void>();
  const keyFor = (host: string, port: number, device: number) => `${openrgbConnectionKey(host, port)}#${device}`;
  return {
    /** Stream to the device (replacing a stream already going to it); 0 seconds stops it. Answers its LED count. */
    async start(host: string, port: number, device: number, seconds: number): Promise<{ leds: number; name: string }> {
      const key = keyFor(host, port, device);
      running.get(key)?.();
      if (seconds <= 0) return { leds: 0, name: '' };
      const connection = connect(host, port);
      let data: ControllerData;
      try {
        await connection.open();
        data = await connection.prepare(device);
      } catch (err) {
        connection.end();
        throw openrgbHttpError(err, connection.where());
      }
      if (data.leds < 1) {
        connection.end();
        return { leds: 0, name: data.name };
      }
      const started = clock();
      let handle: unknown = null;
      const stop = () => {
        if (handle !== null) stopEvery(handle as never);
        handle = null;
        if (running.get(key) === stop) running.delete(key);
        connection.restore(device);
        connection.end();
      };
      const tick = () => {
        const elapsed = clock() - started;
        if (elapsed >= seconds * 1000) { stop(); return; }
        connection.send(device, identifyPixels(data.leds, false, elapsed), data.leds);
      };
      running.set(key, stop);
      tick();
      handle = every(tick, PIXEL_FRAME_MS);
      if (handle && typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref();
      return { leds: data.leds, name: data.name };
    },
    stop(host: string, port: number, device: number): void { running.get(keyFor(host, port, device))?.(); },
    stopAll(): void { for (const stop of [...running.values()]) stop(); },
    active(): string[] { return [...running.keys()]; },
  };
}

export {
  openrgbProfileId,
  openrgbProfile,
  createOpenRgbIdentify,
};
