// Hue lamps for the tests, on profiles built as the server builds them from
// what a bridge reports (src/server/hue-profile.ts).

import { hueProfile } from '../../src/server/hue-profile.ts';

/** A lamp of an entertainment area, as hue.ts lists it. */
export function areaLamp({ id, name = 'Lamp', product = 'Hue color lamp', channels = [0], gamut = 'C', whites = { warm: 2000, cool: 6536 }, fixedWhite = null, devices = [`device-${id}`] }) {
  return { id, name, product, devices, channels, kind: gamut ? 'color' : whites ? 'ambiance' : 'white', capabilities: { gamut, whites, fixedWhite } };
}

/** A colour bulb that tunes white too: dimmer, RGB, two whites, UV. */
export const HUE_COLOR = hueProfile(areaLamp({ id: 'test-color' }));
/** A tunable-white bulb: dimmer and two whites. */
export const HUE_AMBIANCE = hueProfile(areaLamp({ id: 'test-ambiance', product: 'Hue white ambiance', gamut: null, whites: { warm: 2203, cool: 6536 } }));
/** A bulb that only dims, at 2700 K. */
export const HUE_WHITE = hueProfile(areaLamp({ id: 'test-white', product: 'Hue white lamp', gamut: null, whites: null, fixedWhite: 2732 }));
/** A gradient strip of five sections. */
export const HUE_GRADIENT = hueProfile(areaLamp({ id: 'test-gradient', product: 'Hue gradient lightstrip', channels: [3, 4, 5, 6, 7] }));
