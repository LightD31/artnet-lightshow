import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { EMITTERS, MAX_CELLS_PER_FIXTURE } from './shared/rig.ts';
import { STROBE_FUNCTIONS } from './server/presets.ts';
import type { ChannelDefault, ChannelListEntry, ChannelMap, ImportedFixture, ImportedMode } from './types/rig.ts';

type XmlNode = { [key: string]: unknown };

interface XmlChannelSet {
  '@_Name'?: string;
  '@_DMXFrom'?: string | number;
}

interface XmlChannelFunction {
  '@_PhysicalFrom'?: string | number;
  '@_PhysicalTo'?: string | number;
  '@_Attribute'?: string;
  '@_Name'?: string;
  '@_DMXFrom'?: string | number;
  '@_Default'?: string | number;
  '@_ModeMaster'?: string;
  ChannelSet?: XmlChannelSet[];
}

interface XmlLogicalChannel {
  '@_Attribute'?: string;
  ChannelFunction?: XmlChannelFunction[];
}

interface XmlDmxChannel {
  '@_Offset'?: string | number;
  '@_Geometry'?: string;
  '@_DMXBreak'?: string;
  '@_Default'?: string | number;
  '@_InitialFunction'?: string;
  LogicalChannel?: XmlLogicalChannel[];
}

interface XmlDmxMode {
  '@_Name'?: string;
  '@_Geometry'?: string;
  DMXChannels?: { DMXChannel?: XmlDmxChannel[] };
}

interface XmlFixtureType {
  '@_Name'?: string;
  '@_LongName'?: string;
  '@_Manufacturer'?: string;
  DMXModes?: { DMXMode?: XmlDmxMode[] };
  Geometries?: XmlNode;
}

interface GeometryRef {
  name: string | undefined;
  template: string | undefined;
  breaks: { dmxBreak: number; offset: number }[];
}

interface GeometryIndex {
  topOf: Map<string, string>;
  references: GeometryRef[];
}

interface ModeEntry {
  key: string | undefined;
  bytes: number[];
  attrName: string | null;
  displayName: string;
  order: number;
  attribute?: string | null;
  values: ChannelValues;
  unmapped?: boolean;
}

type Effect = 'open' | 'closed' | 'strobe' | 'flash' | 'dimmer' | 'none' | 'other';

interface ChannelValues {
  strobeHz?: { min: number; max: number };
  width: number;
  ranges: { from: number; effect: Effect }[];
  rest: number;
}

interface ChunkStream {
  on(event: 'data', fn: (chunk: Uint8Array) => void): ChunkStream;
  on(event: 'error', fn: (err: Error) => void): ChunkStream;
  on(event: 'end', fn: () => void): ChunkStream;
  pause(): ChunkStream;
  resume(): ChunkStream;
}

const asList = <T>(value: T | T[] | null | undefined): T[] => (value == null ? [] : ([] as T[]).concat(value));

const MAX_DESCRIPTION_BYTES = 16 * 1024 * 1024;

const ATTR_MAP: Record<string, string> = {
  'Dimmer':           'dimmer',
  'Dimmer1':          'dimmer',
  'DimmerFine':       'dimmerFine',
  'Shutter':          'strobe',
  'Shutter1':         'strobe',
  'ShutterStrobe':    'strobe',
  'StrobeFrequency':  'strobe',
  'ColorAdd_R':       'red',
  'ColorRGB_Red':     'red',
  'ColorAdd_G':       'green',
  'ColorRGB_Green':   'green',
  'ColorAdd_B':       'blue',
  'ColorRGB_Blue':    'blue',
  'ColorAdd_W':       'white',
  'ColorAdd_WW':      'white',
  'ColorAdd_CW':      'white',
  'ColorAdd_A':       'amber',
  'ColorAdd_Amber':   'amber',
  'ColorAdd_RY':      'amber',
  'ColorAdd_GY':      'lime',
  'ColorAdd_UV':      'uv',
  'ColorAdd_L':       'lime',
  'ColorAdd_I':       'indigo',
  'ColorAdd_C':       'cyan',
  'ColorAdd_M':       'magenta',
  'ColorAdd_Y':       'yellow',
  'Pan':              'pan',
  'Tilt':             'tilt',
  'PanFine':          'panFine',
  'TiltFine':         'tiltFine',
  'Gobo1':            'gobo',
  'Gobo2':            'gobo2',
  'Prism':            'prism',
  'Prism1':           'prism',
  'Focus':            'focus',
  'Focus1':           'focus',
  'Zoom':             'zoom',
  'Iris':             'iris',
  'Frost':            'frost',
  'Frost1':           'frost',
  'ColorMacro':       'macro',
  'ColorMacro1':      'macro',
  'NoFeature':        'noFeature',
};

function attributeBase(attrString: string | null | undefined): string {
  return attrString ? attrString.split('.')[0].replace(/\s+\d+$/, '') : '';
}

function resolveAttribute(attrString: string | null | undefined): string | null {
  if (!attrString) return null;
  return ATTR_MAP[attributeBase(attrString)] || ATTR_MAP[attrString] || null;
}

/**
 * Parse a GDTF file buffer and extract fixture profiles (one per DMX mode).
 * @param {Buffer} fileBuffer - The .gdtf file contents
 * @returns {Promise<{name, manufacturer, modes: Array<{modeName, channelCount, channelMap, channelList}>}>}
 */
async function parseGDTF(fileBuffer: Buffer | Uint8Array | ArrayBuffer): Promise<ImportedFixture> {
  const zip = await JSZip.loadAsync(fileBuffer);

  let descFile = null as JSZip.JSZipObject | null;
  zip.forEach((relativePath, entry) => {
    if (relativePath.toLowerCase() === 'description.xml') {
      descFile = entry;
    }
  });

  if (!descFile) {
    throw new Error('No description.xml found in GDTF file');
  }

  const internals = (descFile as unknown as { _data?: { uncompressedSize?: number } })._data;
  const declaredSize = internals && internals.uncompressedSize;
  if (typeof declaredSize === 'number' && Number.isFinite(declaredSize) && declaredSize > MAX_DESCRIPTION_BYTES) {
    throw new Error(
      `description.xml is too large (${Math.round(declaredSize / 1024 / 1024)} MB, limit ` +
      `${Math.round(MAX_DESCRIPTION_BYTES / 1024 / 1024)} MB)`
    );
  }

  // Bound actual inflated bytes because an archive can understate its declared size.
  const xmlContent = await inflateCapped(descFile, MAX_DESCRIPTION_BYTES);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['DMXMode', 'DMXChannel', 'LogicalChannel', 'ChannelFunction', 'ChannelSet', 'GeometryReference', 'Break'].includes(name),
  });

  const parsed = parser.parse(xmlContent);

  const fixtureType: XmlFixtureType | undefined = parsed.GDTF?.FixtureType || parsed.FixtureType;
  if (!fixtureType) {
    throw new Error('Invalid GDTF: no FixtureType element found');
  }

  const name = fixtureType['@_Name'] || fixtureType['@_LongName'] || 'Unknown Fixture';
  const manufacturer = fixtureType['@_Manufacturer'] || 'Unknown';

  const dmxModes = fixtureType.DMXModes?.DMXMode;
  if (!dmxModes || dmxModes.length === 0) {
    throw new Error('No DMX modes found in GDTF file');
  }

  const geometries = indexGeometries(fixtureType.Geometries);
  const modes = dmxModes.map((mode) => parseMode(mode, geometries));

  return { name, manufacturer, modes };
}

function indexGeometries(root: XmlNode | undefined): GeometryIndex {
  const topOf = new Map<string, string>();
  const references: GeometryRef[] = [];
  const visit = (node: XmlNode | undefined, top: string | null | undefined) => {
    for (const [key, value] of Object.entries(node || {})) {
      if (key.startsWith('@_') || key === '#text') continue;
      for (const child of asList(value as XmlNode | XmlNode[])) {
        if (!child || typeof child !== 'object') continue;
        const name = child['@_Name'] as string | undefined;
        const ancestor = top ?? name;
        if (name != null && !topOf.has(name)) topOf.set(name, top ?? name);
        if (key === 'GeometryReference') {
          references.push({
            name,
            template: child['@_Geometry'] as string | undefined,
            breaks: asList(child.Break as XmlNode | XmlNode[] | undefined).map((b) => ({
              dmxBreak: parseInt(String(b['@_DMXBreak'] ?? '1'), 10) || 1,
              offset: dmxOffset(b['@_DMXOffset']),
            })),
          });
        }
        visit(child, ancestor);
      }
    }
  };
  visit(root, null);
  return { topOf, references };
}

function dmxOffset(raw: unknown): number {
  const text = String(raw ?? '1');
  if (text.includes('.')) {
    const [universe, address] = text.split('.').map((v) => parseInt(v, 10));
    return (Math.max(1, universe || 1) - 1) * 512 + (address || 1);
  }
  return parseInt(text, 10) || 1;
}

function describeChannel(ch: XmlDmxChannel, fallbackName: string): { attrName: string | null; displayName: string } {
  const logical = asList(ch.LogicalChannel);
  let attrName: string | null = null;
  let displayName = fallbackName;
  if (logical.length > 0) {
    const lc = logical[0];
    attrName = lc['@_Attribute'] || null;
    const cf = asList(lc.ChannelFunction);
    if (cf.length > 0 && cf[0]['@_Attribute']) {
      attrName = attrName || cf[0]['@_Attribute'];
      if (cf[0]['@_Name']) displayName = cf[0]['@_Name'];
    }
  }
  return { attrName, displayName };
}

const STANDARD_STROBE = STROBE_FUNCTIONS.find((f) => f.id === 'standard') || STROBE_FUNCTIONS[0];

function dmxValue(raw: unknown, width: number): number | null {
  if (raw === undefined || raw === null) return null;
  const m = /^\s*(\d+)(?:\/(\d+)(s?))?\s*$/.exec(String(raw));
  if (!m) return null;
  const value = Number(m[1]);
  const bytes = Math.max(1, Number(m[2] || 1));
  const top = 256 ** width - 1;
  if (m[3]) return Math.min(top, Math.round((value / (256 ** bytes - 1)) * top));
  const scaled = bytes <= width ? value * 256 ** (width - bytes) : Math.floor(value / 256 ** (bytes - width));
  return Math.min(top, scaled);
}

function effectOf(attribute: string, name: string): Effect {
  const base = attributeBase(attribute).replace(/^Shutter\d*/, 'Shutter');
  if (base === 'NoFeature') return 'none';
  if (base.startsWith('Dimmer')) return 'dimmer';
  if (base === 'ShutterStrobe' || base === 'ShutterStrobePulse' || base === 'StrobeFrequency') return 'strobe';
  if (base.startsWith('ShutterStrobe') || base.startsWith('Strobe')) return 'flash';
  if (base !== 'Shutter') return 'other';
  if (/clos|blackout/i.test(name)) return 'closed';
  if (/open/i.test(name)) return 'open';
  if (/random/i.test(name)) return 'flash';
  if (/strobe|pulse|flash/i.test(name)) return 'strobe';
  return 'other';
}

function readValues(ch: XmlDmxChannel, width: number): ChannelValues {
  const functions: { fn: XmlChannelFunction; attribute: string }[] = [];
  for (const lc of asList(ch.LogicalChannel)) {
    for (const fn of asList(lc.ChannelFunction)) functions.push({ fn, attribute: fn['@_Attribute'] || lc['@_Attribute'] || '' });
  }
  const plain = functions.filter((f) => !f.fn['@_ModeMaster']);
  const used = plain.length ? plain : functions;

  const ranges: { from: number; effect: Effect }[] = [];
  for (const { fn, attribute } of used) {
    const own = effectOf(attribute, fn['@_Name'] || '');
    ranges.push({ from: dmxValue(fn['@_DMXFrom'], width) ?? 0, effect: own });
    for (const set of asList(fn.ChannelSet)) {
      const from = dmxValue(set['@_DMXFrom'], width);
      if (from === null || !set['@_Name']) continue;
      const named = effectOf(attribute, set['@_Name']);
      ranges.push({ from, effect: named === 'other' ? own : named });
    }
  }
  ranges.sort((a, b) => a.from - b.from);
  const distinct = ranges.filter((r, i) => i === ranges.length - 1 || ranges[i + 1].from !== r.from);

  const initial = ch['@_InitialFunction'] ? ch['@_InitialFunction'].split('.').pop() : undefined;
  const rest = (initial !== undefined ? dmxValue(used.find((f) => f.fn['@_Name'] === initial)?.fn['@_Default'], width) : null)
    ?? dmxValue(ch['@_Default'], width)
    ?? dmxValue(used[0]?.fn['@_Default'], width)
    ?? 0;
  let strobeHz: ChannelValues['strobeHz'];
  const unit = 256 ** (width - 1), low = STANDARD_STROBE.lo * unit, high = STANDARD_STROBE.hi * unit;
  for (let i = 0; i < used.length; i++) {
    const { fn, attribute } = used[i];
    const from = dmxValue(fn['@_DMXFrom'], width) ?? 0;
    const to = i + 1 < used.length ? (dmxValue(used[i + 1].fn['@_DMXFrom'], width) ?? 0) - 1 : 256 ** width - 1;
    const first = Number(fn['@_PhysicalFrom']), last = Number(fn['@_PhysicalTo']);
    if (effectOf(attribute, fn['@_Name'] || '') !== 'strobe' || from > low || to < high || !(first >= 0 && last > 0 && last >= first && last <= 100)) continue;
    const at = (v: number) => first + (last - first) * (v - from) / Math.max(1, to - from);
    strobeHz = { min: at(low), max: at(high) };
  }
  return { width, ranges: distinct, rest, strobeHz };
}

function rangeAt(values: ChannelValues, value: number): { from: number; effect: Effect } | null {
  let found: { from: number; effect: Effect } | null = null;
  for (const range of values.ranges) {
    if (range.from > value) break;
    found = range;
  }
  return found;
}

function restOf(values: ChannelValues, dimmer: boolean): { value: number; why: 'open' | 'full' | 'closed' | null } {
  const at = rangeAt(values, values.rest);
  if (at?.effect === 'closed') {
    const open = values.ranges.find((r) => r.effect === 'open') || values.ranges.find((r) => r.effect === 'none');
    return open ? { value: open.from, why: 'open' } : { value: values.rest, why: 'closed' };
  }
  if (dimmer && (!values.ranges.length || at?.effect === 'dimmer')) {
    const top = 256 ** values.width - 1;
    const last = values.ranges.findLastIndex((r) => r.effect === 'dimmer');
    const full = last < 0 ? top : (values.ranges[last + 1]?.from ?? top + 1) - 1;
    if (full !== values.rest) return { value: full, why: 'full' };
  }
  return { value: values.rest, why: null };
}

function strobesLikeTheShow(values: ChannelValues, rest: number): boolean {
  const at = rangeAt(values, rest);
  if (!at || !(at.effect === 'open' || at.effect === 'none')) return false;
  const step = 256 ** (values.width - 1);
  for (let v = STANDARD_STROBE.lo; v <= STANDARD_STROBE.hi; v++) {
    if (rangeAt(values, v * step)?.effect !== 'strobe') return false;
  }
  return true;
}

function byteOf(value: number, width: number, index: number): number {
  return Math.floor(value / 256 ** (width - 1 - index)) % 256;
}

function parseMode(mode: XmlDmxMode, geometries: GeometryIndex): ImportedMode {
  const modeName = mode['@_Name'] || 'Default';
  const root = mode['@_Geometry'] || null;
  const channels = mode.DMXChannels?.DMXChannel || [];
  const warnings: string[] = [];
  const entries: ModeEntry[] = [];

  channels.forEach((ch, idx) => {
    const rawOffset = ch['@_Offset'];
    if (rawOffset == null || String(rawOffset).trim() === '' || String(rawOffset).trim() === 'None') return;
    const bytes = String(rawOffset).split(',').map((v) => parseInt(v, 10)).filter(Number.isFinite);
    if (!bytes.length) return;

    const geometry = ch['@_Geometry'] || root || '';
    const { attrName, displayName } = describeChannel(ch, geometry || `Channel ${bytes[0]}`);
    const channelBreak = ch['@_DMXBreak'] ?? '1';
    const values = readValues(ch, bytes.length);

    const template = geometry ? geometries.topOf.get(geometry) : undefined;
    const refs = template ? geometries.references.filter((r) => r.template === template) : [];
    const instances = refs.length
      ? refs.map((r) => {
        const b = channelBreak === 'Overwrite'
          ? r.breaks[r.breaks.length - 1]
          : r.breaks.find((x) => x.dmxBreak === (parseInt(channelBreak, 10) || 1));
        return b ? { key: r.name, shift: b.offset - 1, dmxBreak: b.dmxBreak } : null;
      }).filter((i): i is { key: string | undefined; shift: number; dmxBreak: number } => i !== null)
      : [{ key: geometry, shift: 0, dmxBreak: channelBreak === 'Overwrite' ? 1 : (parseInt(channelBreak, 10) || 1) }];

    for (const { key, shift, dmxBreak } of instances) {
      const label = key && !displayName.startsWith(key) ? `${key} ${displayName}` : displayName;
      if (dmxBreak !== 1) {
        warnings.push(`${label} is on DMX break ${dmxBreak}; only the first break is patched`);
        continue;
      }
      const addressed = bytes.map((b) => b + shift - 1);
      if (addressed.some((a) => a < 0 || a > 511)) {
        warnings.push(`${label} would sit past channel 512 and was left out`);
        continue;
      }
      entries.push({ key, bytes: addressed, attrName, displayName, order: idx, values });
    }
  });

  const bases = new Set(entries.map((e) => attributeBase(e.attrName)));
  const splitWhites = bases.has('ColorAdd_WW') && bases.has('ColorAdd_CW');
  for (const e of entries) {
    const base = attributeBase(e.attrName);
    e.attribute = splitWhites && base === 'ColorAdd_WW' ? 'warmWhite'
      : splitWhites && base === 'ColorAdd_CW' ? 'coolWhite'
        : resolveAttribute(e.attrName);
  }

  const notes = new Map<string, { attr: string; what: string; channels: number[] }>();
  const note = (e: ModeEntry, what: string) => {
    const attr = e.attrName || e.displayName;
    const id = `${attr}\u0000${what}`;
    const entry = notes.get(id) || { attr, what, channels: [] };
    entry.channels.push(e.bytes[0] + 1);
    notes.set(id, entry);
  };

  // Keep non-strobing shutters open so unsupported hardware does not black out the fixture.
  for (const e of entries) {
    if (e.attribute === 'strobe' && e.values.ranges.length && !e.values.ranges.some((r) => r.effect === 'strobe' || r.effect === 'flash')) {
      e.attribute = 'shutter';
    }
  }

  const firstAddress = new Map<string, number>();
  for (const e of entries) {
    if (!e.key || e.key === root || !e.attribute || !EMITTERS.includes(e.attribute)) continue;
    firstAddress.set(e.key, Math.min(firstAddress.get(e.key) ?? Infinity, e.bytes[0]));
  }
  let cellKeys = [...firstAddress.keys()].sort((a, b) => (firstAddress.get(a) as number) - (firstAddress.get(b) as number));
  if (cellKeys.length < 2) cellKeys = [];
  if (cellKeys.length > MAX_CELLS_PER_FIXTURE) {
    warnings.push(`${cellKeys.length} cells is more than the ${MAX_CELLS_PER_FIXTURE} a fixture may have; only the first are used`);
    cellKeys = cellKeys.slice(0, MAX_CELLS_PER_FIXTURE);
  }
  const cellIndex = new Map<string | undefined, number>(cellKeys.map((key, i) => [key, i]));

  const channelList: (ChannelListEntry & { gdtfAttribute: string | null })[] = [];
  for (const e of entries) {
    const cell = cellIndex.get(e.key);
    const name = cell !== undefined && e.key && !e.displayName.startsWith(e.key) ? `${e.key} ${e.displayName}` : e.displayName;
    const attribute = e.attribute || e.attrName || 'unknown';
    e.bytes.forEach((offset, byte) => {
      channelList.push({
        offset,
        name: byte === 0 ? name : `${name} fine`,
        attribute: byte === 0 ? attribute : `${attribute}Fine`,
        gdtfAttribute: e.attrName,
        ...(cell !== undefined ? { cell } : {}),
      });
    });
  }
  channelList.sort((a, b) => a.offset - b.offset);

  // Drive only shutters whose rest and flashing range match the show’s strobe contract.
  for (const e of entries) {
    if (e.attribute !== 'strobe' || !e.values.ranges.length || cellIndex.has(e.key)) continue;
    if (strobesLikeTheShow(e.values, restOf(e.values, false).value)) continue;
    e.unmapped = true;
    note(e, `does not strobe as the show expects (open at rest, flashing from ${STANDARD_STROBE.lo} to ${STANDARD_STROBE.hi}), so the show flashes this fixture itself`);
  }

  const mapInto = (map: ChannelMap, e: ModeEntry) => {
    if (!e.attribute || e.unmapped || e.attribute in map) return;
    map[e.attribute] = e.bytes[0];
    if (e.attribute === 'dimmer' && e.bytes.length > 1 && !('dimmerFine' in map)) map.dimmerFine = e.bytes[1];
  };
  const inOrder = [...entries].sort((a, b) => a.order - b.order || a.bytes[0] - b.bytes[0]);
  const channelMap: ChannelMap = {};
  const cellMaps: ChannelMap[] = cellKeys.map(() => ({}));
  for (const e of inOrder) {
    const cell = cellIndex.get(e.key);
    if (cell !== undefined) mapInto(cellMaps[cell], e);
    else mapInto(channelMap, e);
  }

  // Include sparse offsets and fine bytes in the footprint so writes cannot escape overlap and clearing checks.
  const channelCount = channelList.reduce((max, ch) => Math.max(max, ch.offset), -1) + 1;

  const written = new Set<number>();
  for (const [attr, offset] of Object.entries(channelMap)) {
    if (offset === undefined) continue;
    if (attr === 'dimmer' || attr === 'dimmerFine' || (!cellKeys.length && EMITTERS.includes(attr))) written.add(offset);
  }
  for (const map of cellMaps) {
    for (const [attr, offset] of Object.entries(map)) {
      if (offset !== undefined && (attr === 'dimmer' || EMITTERS.includes(attr))) written.add(offset);
    }
  }
  const held = new Map<number, number>();
  for (const e of entries) {
    const driven = written.has(e.bytes[0]);
    const rest = driven ? { value: e.values.rest, why: null } : restOf(e.values, e.attribute === 'dimmer');
    e.bytes.forEach((offset, byte) => {
      const value = byteOf(rest.value, e.values.width, byte);
      if (!written.has(offset) && value > 0 && !held.has(offset)) held.set(offset, value);
    });
    const shown = byteOf(rest.value, e.values.width, 0);
    if (rest.why === 'open') note(e, `is held at ${shown}, open, so the light is not shut`);
    else if (rest.why === 'full') note(e, `is held at ${shown}, full: the show does not drive it`);
    else if (rest.why === 'closed') note(e, 'shuts the light at rest and has no open value; the fixture stays dark in this mode');
  }
  for (const { attr, what, channels: at } of notes.values()) {
    const list = at.length === 1 ? `channel ${at[0]}` : `channels ${at.slice(0, -1).join(', ')} and ${at[at.length - 1]}`;
    warnings.push(`${attr} on ${list} ${what}`);
  }

  const result: ImportedMode = { modeName, channelCount, channelMap, channelList };
  const strobe = entries.find((e) => e.attribute === 'strobe' && e.bytes[0] === channelMap.strobe);
  if (strobe?.values.strobeHz) result.strobeHz = strobe.values.strobeHz;
  if (cellKeys.length) result.cells = cellKeys.map((key, i) => ({ name: String(key).slice(0, 64), channelMap: cellMaps[i] }));
  if (held.size) result.defaults = [...held].sort((a, b) => a[0] - b[0]).map(([offset, value]): ChannelDefault => ({ offset, value }));
  if (warnings.length) result.warnings = warnings;
  return result;
}

function inflateCapped(entry: JSZip.JSZipObject, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): ChunkStream }).internalStream('uint8array');
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try { stream.pause(); } catch (_) { /* already stopped */ }
      reject(err);
    };
    stream
      .on('data', (chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.length;
        if (total > limit) {
          fail(new Error(`description.xml is too large (over ${Math.round(limit / 1024 / 1024)} MB once decompressed)`));
          return;
        }
        chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      })
      .on('error', fail)
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      })
      .resume();
  });
}

export {
  parseGDTF,
  inflateCapped,
};
