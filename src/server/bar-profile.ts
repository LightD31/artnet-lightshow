import { z } from 'zod';
import { MAX_CELLS_PER_FIXTURE } from '../shared/rig.ts';
import { profileSchema, validate } from './validation.ts';
import { HttpError } from '../errors.ts';
import type { ProfileInput } from './validation.ts';
import type { ChannelListEntry, ChannelMap, ProfileCell } from '../types/rig.ts';

const LETTERS: Record<string, { attribute: string; name: string }> = {
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
  firstChannel: channelNo,
  order: z.string().regex(/^[RGBWAUD]{1,8}$/, 'letters R G B W A U D, each once')
    .refine((v) => new Set(v).size === v.length, 'each letter once')
    .refine((v) => /[RGBWAU]/.test(v), 'at least one colour'),
  stride: z.number().int().min(1).max(64).optional(),
  dimmer: channelNo.optional(),
  strobe: channelNo.optional(),
}).strict();

function barProfile(spec: unknown): ProfileInput {
  const bar = validate(barSpecSchema, spec, 'bar');
  const stride = bar.stride ?? bar.order.length;
  if (stride < bar.order.length) throw badBar(`each cell has ${bar.order.length} channels, so cells cannot start ${stride} apart`);

  const channelMap: ChannelMap = {};
  const channelList: ChannelListEntry[] = [];
  if (bar.dimmer !== undefined) {
    channelMap.dimmer = bar.dimmer - 1;
    channelList.push({ offset: bar.dimmer - 1, name: 'Dimmer', attribute: 'dimmer' });
  }
  if (bar.strobe !== undefined) {
    channelMap.strobe = bar.strobe - 1;
    channelList.push({ offset: bar.strobe - 1, name: 'Strobe', attribute: 'strobe' });
  }

  const cells: ProfileCell[] = [];
  for (let c = 0; c < bar.cells; c++) {
    const start = bar.firstChannel - 1 + c * stride;
    const map: ChannelMap = {};
    [...bar.order].forEach((letter, k) => {
      const { attribute, name } = LETTERS[letter];
      map[attribute] = start + k;
      channelList.push({ offset: start + k, name: `Cell ${c + 1} ${name}`, attribute, cell: c });
    });
    cells.push({ name: `Cell ${c + 1}`, channelMap: map });
  }
  channelList.sort((a, b) => a.offset - b.offset);

  const channelCount = channelList.reduce((max, ch) => Math.max(max, ch.offset), -1) + 1;
  const plain = bar.firstChannel === 1 && stride === bar.order.length && bar.dimmer === undefined && bar.strobe === undefined;
  if (channelCount > 512 && !plain) {
    throw badBar(`${bar.cells} cells of ${stride} channels from channel ${bar.firstChannel} end at ${channelCount}, past the 512-channel universe; `
      + 'a strip longer than a universe runs on into the next only as plain pixels from channel 1, with no gaps and no bar dimmer or strobe');
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

function badBar(message: string): HttpError {
  return new HttpError(400, `bar: ${message}`);
}

export {
  barProfile,
  barSpecSchema,
};
