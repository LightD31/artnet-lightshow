/**
 * A profile for an LED bar, from the few numbers on the back of its manual.
 *
 * Plenty of bars ship without a GDTF file, and their pixel modes are all the
 * same shape: a couple of channels for the whole bar, then N cells of the same
 * few channels one after another. Typing that in as a hundred-channel
 * profile is what nobody does, so this builds it from the cell count, where
 * the first cell starts, and the order of each cell's channels.
 */

import { z } from 'zod';
import { MAX_CELLS_PER_FIXTURE } from '../shared/rig.js';
import { profileSchema, validate } from './validation.js';

// One letter per channel of a cell, in the order the manual lists them.
const LETTERS = {
  R: { attribute: 'red', name: 'Red' },
  G: { attribute: 'green', name: 'Green' },
  B: { attribute: 'blue', name: 'Blue' },
  W: { attribute: 'white', name: 'White' },
  A: { attribute: 'amber', name: 'Amber' },
  U: { attribute: 'uv', name: 'UV' },
  D: { attribute: 'dimmer', name: 'Dimmer' },
};

const channelNo = z.number().int().min(1).max(512);

const barSpecSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1).max(128),
  manufacturer: z.string().max(128).optional(),
  cells: z.number().int().min(2).max(MAX_CELLS_PER_FIXTURE),
  // The DMX channel of cell 1's first channel, counted from 1.
  firstChannel: channelNo,
  // What each cell's channels are, in order: "RGB", "RGBW", "DRGB"…
  order: z.string().regex(/^[RGBWAUD]{1,8}$/, 'letters R G B W A U D, each once')
    .refine((v) => new Set(v).size === v.length, 'each letter once')
    .refine((v) => /[RGBWAU]/.test(v), 'at least one colour'),
  // Channels from one cell to the next; the length of `order` unless the bar
  // leaves gaps between cells.
  stride: z.number().int().min(1).max(64).optional(),
  // The channels the whole bar shares, counted from 1.
  dimmer: channelNo.optional(),
  strobe: channelNo.optional(),
}).strict();

/**
 * The profile for a bar, validated as any other profile is. Throws with a
 * `status` of 400 when the numbers do not describe a bar that fits.
 */
function barProfile(spec) {
  const bar = validate(barSpecSchema, spec, 'bar');
  const stride = bar.stride ?? bar.order.length;
  if (stride < bar.order.length) throw badBar(`each cell has ${bar.order.length} channels, so cells cannot start ${stride} apart`);

  const channelMap = {};
  const channelList = [];
  if (bar.dimmer !== undefined) {
    channelMap.dimmer = bar.dimmer - 1;
    channelList.push({ offset: bar.dimmer - 1, name: 'Dimmer', attribute: 'dimmer' });
  }
  if (bar.strobe !== undefined) {
    channelMap.strobe = bar.strobe - 1;
    channelList.push({ offset: bar.strobe - 1, name: 'Strobe', attribute: 'strobe' });
  }

  const cells = [];
  for (let c = 0; c < bar.cells; c++) {
    const start = bar.firstChannel - 1 + c * stride;
    const map = {};
    [...bar.order].forEach((letter, k) => {
      const { attribute, name } = LETTERS[letter];
      map[attribute] = start + k;
      channelList.push({ offset: start + k, name: `Cell ${c + 1} ${name}`, attribute, cell: c });
    });
    cells.push({ name: `Cell ${c + 1}`, channelMap: map });
  }
  channelList.sort((a, b) => a.offset - b.offset);

  const channelCount = channelList.reduce((max, ch) => Math.max(max, ch.offset), -1) + 1;
  if (channelCount > 512) {
    throw badBar(`${bar.cells} cells of ${stride} channels from channel ${bar.firstChannel} end at ${channelCount}, past the 512-channel universe`);
  }

  return validate(profileSchema, {
    id: bar.id,
    name: bar.name,
    manufacturer: bar.manufacturer || 'Custom',
    modeName: `${bar.cells} × ${bar.order}`,
    channelCount,
    channelMap,
    channelList,
    cells,
  }, 'bar');
}

function badBar(message) {
  const err = new Error(`bar: ${message}`);
  err.status = 400;
  return err;
}

export {
  barProfile,
  barSpecSchema,
};
