import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { EMITTERS, MAX_CELLS_PER_FIXTURE } from './shared/rig.ts';
import { STROBE_FUNCTIONS } from './server/presets.ts';
import type { ChannelDefault, ChannelListEntry, ChannelMap, ImportedFixture, ImportedMode } from './types/rig.ts';

// The parts of description.xml this reads. It comes from a file anyone can
// write, so every attribute is treated as possibly missing.
type XmlNode = { [key: string]: unknown };

interface XmlChannelSet {
  '@_Name'?: string;
  '@_DMXFrom'?: string | number;
}

interface XmlChannelFunction {
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
  /** GDTF 1.0: the channel's value at rest. */
  '@_Default'?: string | number;
  /** GDTF 1.1+: "Channel.LogicalChannel.ChannelFunction", the function it starts on. */
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

/** A GeometryReference: the template it places and where its channels land. */
interface GeometryRef {
  name: string | undefined;
  template: string | undefined;
  breaks: { dmxBreak: number; offset: number }[];
}

interface GeometryIndex {
  topOf: Map<string, string>;
  references: GeometryRef[];
}

/** One channel of a mode, placed: which geometry, which bytes, what it does. */
interface ModeEntry {
  key: string | undefined;
  bytes: number[];
  attrName: string | null;
  displayName: string;
  order: number;
  attribute?: string | null;
  /** What each range of its values does, and where it sits at rest. */
  values: ChannelValues;
  /** A shutter the show cannot run as its strobe: left to the software strobe. */
  unmapped?: boolean;
}

/** What a stretch of a channel's values does, as far as holding the light open is concerned. */
type Effect = 'open' | 'closed' | 'strobe' | 'flash' | 'dimmer' | 'none' | 'other';

/** A channel's value ranges and its value at rest, in its own resolution (all its bytes). */
interface ChannelValues {
  width: number;
  /** Each range from where it starts to the next one, in order; empty when the file gives none. */
  ranges: { from: number; effect: Effect }[];
  rest: number;
}

/** JSZip's streamed read of one entry (not in its published types). */
interface ChunkStream {
  on(event: 'data', fn: (chunk: Uint8Array) => void): ChunkStream;
  on(event: 'error', fn: (err: Error) => void): ChunkStream;
  on(event: 'end', fn: () => void): ChunkStream;
  pause(): ChunkStream;
  resume(): ChunkStream;
}

/** A value, or a list of them, as a list (the XML parser gives either). */
const asList = <T>(value: T | T[] | null | undefined): T[] => (value == null ? [] : ([] as T[]).concat(value));

// Upper bound on the decompressed description.xml. Real fixture definitions are
// a few hundred KB at most; anything past this is a zip bomb, not a fixture.
const MAX_DESCRIPTION_BYTES = 16 * 1024 * 1024;

// Map GDTF attribute names to our internal channel attributes
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
  // GDTF's own name for amber is red-yellow; A and Amber are what fixture
  // builders wrote before the attribute list settled.
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

/** A GDTF attribute without its dotted qualifiers or trailing number. */
function attributeBase(attrString: string | null | undefined): string {
  // GDTF attributes can be dotted like "Dimmer.Dimmer.Dimmer 1"
  // Take the first segment
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

  // Find description.xml (case-insensitive)
  let descFile = null as JSZip.JSZipObject | null;
  zip.forEach((relativePath, entry) => {
    if (relativePath.toLowerCase() === 'description.xml') {
      descFile = entry;
    }
  });

  if (!descFile) {
    throw new Error('No description.xml found in GDTF file');
  }

  // Refuse to decompress a zip bomb. A real GDTF description.xml is well under
  // a megabyte; without this a small upload can expand to gigabytes of heap and
  // take the process down. The size is read from the central
  // directory, so this check happens before any decompression.
  const internals = (descFile as unknown as { _data?: { uncompressedSize?: number } })._data;
  const declaredSize = internals && internals.uncompressedSize;
  if (typeof declaredSize === 'number' && Number.isFinite(declaredSize) && declaredSize > MAX_DESCRIPTION_BYTES) {
    throw new Error(
      `description.xml is too large (${Math.round(declaredSize / 1024 / 1024)} MB, limit ` +
      `${Math.round(MAX_DESCRIPTION_BYTES / 1024 / 1024)} MB)`
    );
  }

  // The declared size above comes from the archive itself, so a crafted file
  // can simply understate it. Inflate as a stream and stop at the limit, so
  // what bounds the heap is the bytes actually produced.
  const xmlContent = await inflateCapped(descFile, MAX_DESCRIPTION_BYTES);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['DMXMode', 'DMXChannel', 'LogicalChannel', 'ChannelFunction', 'ChannelSet', 'GeometryReference', 'Break'].includes(name),
  });

  const parsed = parser.parse(xmlContent);

  // Navigate the GDTF XML structure
  const fixtureType: XmlFixtureType | undefined = parsed.GDTF?.FixtureType || parsed.FixtureType;
  if (!fixtureType) {
    throw new Error('Invalid GDTF: no FixtureType element found');
  }

  const name = fixtureType['@_Name'] || fixtureType['@_LongName'] || 'Unknown Fixture';
  const manufacturer = fixtureType['@_Manufacturer'] || 'Unknown';

  // Parse DMX modes
  const dmxModes = fixtureType.DMXModes?.DMXMode;
  if (!dmxModes || dmxModes.length === 0) {
    throw new Error('No DMX modes found in GDTF file');
  }

  const geometries = indexGeometries(fixtureType.Geometries);
  const modes = dmxModes.map((mode) => parseMode(mode, geometries));

  return { name, manufacturer, modes };
}

// ── Geometry ────────────────────────────────────────────────────────────────
//
// An LED bar in GDTF is a geometry per cell. Either each cell is a geometry of
// its own ("Pixel 1" … "Pixel 16") with channels naming it, or the fixture
// describes one cell as a template geometry and places it N times with
// GeometryReferences, each saying at what DMX offset its copy of the template's
// channels starts. Both come out here as cells.

/**
 * Every named geometry's top-level ancestor (a direct child of <Geometries>,
 * the only kind a GeometryReference may point at), and every reference with
 * the template it places and its breaks.
 */
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

/** A Break's DMXOffset: an address, or "universe.address" counted from 1.1. */
function dmxOffset(raw: unknown): number {
  const text = String(raw ?? '1');
  if (text.includes('.')) {
    const [universe, address] = text.split('.').map((v) => parseInt(v, 10));
    return (Math.max(1, universe || 1) - 1) * 512 + (address || 1);
  }
  return parseInt(text, 10) || 1;
}

/** The attribute and a display name for one DMXChannel, as the flat parser read them. */
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

// ── Values at rest ──────────────────────────────────────────────────────────
//
// The engine writes 0 to every channel it does not drive, and writes a strobe
// channel only while it strobes. On a fixture whose shutter is closed at 0 —
// most moving heads, plenty of pars — that is a dark fixture with nothing on
// screen to say why. So a channel's ChannelFunctions are read for what each
// range of values does: a shutter becomes the show's strobe only when it is
// open at rest and strobes across the show's standard range, and every channel
// the show does not drive is held at its default, a closed shutter held open
// and a dimmer at full (the same rules as the OFL import, src/server/ofl.ts).

const STANDARD_STROBE = STROBE_FUNCTIONS.find((f) => f.id === 'standard') || STROBE_FUNCTIONS[0];

/**
 * A GDTF DMXValue ("128/1", "32768/2", "255/1s" byte-mirrored, or a bare
 * number) in a channel `width` bytes wide; null when there is none.
 */
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

/** What a range does, from its function's attribute and, for a plain shutter, the name it is given. */
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

/** A channel's value ranges, from its ChannelFunctions and their named ChannelSets, and its value at rest. */
function readValues(ch: XmlDmxChannel, width: number): ChannelValues {
  const functions: { fn: XmlChannelFunction; attribute: string }[] = [];
  for (const lc of asList(ch.LogicalChannel)) {
    for (const fn of asList(lc.ChannelFunction)) functions.push({ fn, attribute: fn['@_Attribute'] || lc['@_Attribute'] || '' });
  }
  // A function with a ModeMaster is a second reading of the same values while
  // another channel is in some mode; the plain ones say what the channel does.
  const plain = functions.filter((f) => !f.fn['@_ModeMaster']);
  const used = plain.length ? plain : functions;

  const ranges: { from: number; effect: Effect }[] = [];
  for (const { fn, attribute } of used) {
    const own = effectOf(attribute, fn['@_Name'] || '');
    ranges.push({ from: dmxValue(fn['@_DMXFrom'], width) ?? 0, effect: own });
    // A set names part of its function's range ("Closed", "Open", "Strobe slow → fast").
    for (const set of asList(fn.ChannelSet)) {
      const from = dmxValue(set['@_DMXFrom'], width);
      if (from === null || !set['@_Name']) continue;
      const named = effectOf(attribute, set['@_Name']);
      ranges.push({ from, effect: named === 'other' ? own : named });
    }
  }
  // In order; where two start together, the later — a set within its function — says it.
  ranges.sort((a, b) => a.from - b.from);
  const distinct = ranges.filter((r, i) => i === ranges.length - 1 || ranges[i + 1].from !== r.from);

  // GDTF 1.1 names the function a channel starts on; 1.0 gave the channel a
  // Default of its own; failing both, it starts on its first function.
  const initial = ch['@_InitialFunction'] ? ch['@_InitialFunction'].split('.').pop() : undefined;
  const rest = (initial !== undefined ? dmxValue(used.find((f) => f.fn['@_Name'] === initial)?.fn['@_Default'], width) : null)
    ?? dmxValue(ch['@_Default'], width)
    ?? dmxValue(used[0]?.fn['@_Default'], width)
    ?? 0;
  return { width, ranges: distinct, rest };
}

/** The range a value falls in, or null below the first. */
function rangeAt(values: ChannelValues, value: number): { from: number; effect: Effect } | null {
  let found: { from: number; effect: Effect } | null = null;
  for (const range of values.ranges) {
    if (range.from > value) break;
    found = range;
  }
  return found;
}

/**
 * Where a channel the show does not drive sits: its default, unless that
 * leaves the light dark — then a closed shutter's first open value, or a
 * dimmer's top.
 */
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

/**
 * Can the show run this shutter as its strobe? Between flashes it sits at
 * `rest`, which must leave the light open; flashing, it writes the standard
 * strobe's range, all of which must strobe.
 */
function strobesLikeTheShow(values: ChannelValues, rest: number): boolean {
  const at = rangeAt(values, rest);
  if (!at || !(at.effect === 'open' || at.effect === 'none')) return false;
  const step = 256 ** (values.width - 1);
  for (let v = STANDARD_STROBE.lo; v <= STANDARD_STROBE.hi; v++) {
    if (rangeAt(values, v * step)?.effect !== 'strobe') return false;
  }
  return true;
}

/** Byte `index` (0 the coarse one) of a value `width` bytes wide. */
function byteOf(value: number, width: number, index: number): number {
  return Math.floor(value / 256 ** (width - 1 - index)) % 256;
}

/**
 * One DMX mode as a profile: its footprint, its fixture-level channel map, and
 * — for a fixture that is several lights — its cells, in the order they sit.
 */
function parseMode(mode: XmlDmxMode, geometries: GeometryIndex): ImportedMode {
  const modeName = mode['@_Name'] || 'Default';
  const root = mode['@_Geometry'] || null;
  const channels = mode.DMXChannels?.DMXChannel || [];
  const warnings: string[] = [];
  const entries: ModeEntry[] = [];

  channels.forEach((ch, idx) => {
    // A channel without an address is virtual: a control the fixture's own
    // firmware computes, not one the desk drives.
    const rawOffset = ch['@_Offset'];
    if (rawOffset == null || String(rawOffset).trim() === '' || String(rawOffset).trim() === 'None') return;
    // Highest byte first: "1,2" is a 16-bit channel, coarse on 1 and fine on 2.
    const bytes = String(rawOffset).split(',').map((v) => parseInt(v, 10)).filter(Number.isFinite);
    if (!bytes.length) return;

    const geometry = ch['@_Geometry'] || root || '';
    const { attrName, displayName } = describeChannel(ch, geometry || `Channel ${bytes[0]}`);
    const channelBreak = ch['@_DMXBreak'] ?? '1';
    const values = readValues(ch, bytes.length);

    // A channel on a geometry that is placed by references is a template:
    // one copy per reference, at that reference's offset.
    const template = geometry ? geometries.topOf.get(geometry) : undefined;
    const refs = template ? geometries.references.filter((r) => r.template === template) : [];
    const instances = refs.length
      ? refs.map((r) => {
        // "Overwrite" takes the reference's own break — by convention its last.
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

  // A lamp with both a warm and a cool white die gets both; with only one of
  // them, it is the lamp's white.
  const bases = new Set(entries.map((e) => attributeBase(e.attrName)));
  const splitWhites = bases.has('ColorAdd_WW') && bases.has('ColorAdd_CW');
  for (const e of entries) {
    const base = attributeBase(e.attrName);
    e.attribute = splitWhites && base === 'ColorAdd_WW' ? 'warmWhite'
      : splitWhites && base === 'ColorAdd_CW' ? 'coolWhite'
        : resolveAttribute(e.attrName);
  }

  // What the import holds or leaves alone, one line per kind naming every
  // channel it applies to: a bar repeats its shutter in every cell.
  const notes = new Map<string, { attr: string; what: string; channels: number[] }>();
  const note = (e: ModeEntry, what: string) => {
    const attr = e.attrName || e.displayName;
    const id = `${attr}\u0000${what}`;
    const entry = notes.get(id) || { attr, what, channels: [] };
    entry.channels.push(e.bytes[0] + 1);
    notes.set(id, entry);
  };

  // A shutter that never flashes is a shutter, not a strobe: nothing drives
  // it, and it is held open below. One the file says nothing more about keeps
  // the strobe its attribute names.
  for (const e of entries) {
    if (e.attribute === 'strobe' && e.values.ranges.length && !e.values.ranges.some((r) => r.effect === 'strobe' || r.effect === 'flash')) {
      e.attribute = 'shutter';
    }
  }

  // Cells: the geometries that make light, if there are at least two of them.
  // The mode's own geometry is the fixture as a whole, never a cell.
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

  // The fixture's strobe is the show's only when it behaves as one: open at
  // rest, and strobing across the standard range. A cell's own strobe is never
  // driven, so there is nothing to decide for it.
  for (const e of entries) {
    if (e.attribute !== 'strobe' || !e.values.ranges.length || cellIndex.has(e.key)) continue;
    if (strobesLikeTheShow(e.values, restOf(e.values, false).value)) continue;
    e.unmapped = true;
    note(e, `does not strobe as the show expects (open at rest, flashing from ${STANDARD_STROBE.lo} to ${STANDARD_STROBE.hi}), so the show flashes this fixture itself`);
  }

  // Only the first occurrence of each attribute is driven, per cell and for
  // the fixture as a whole; a 16-bit dimmer's fine byte is its dimmerFine.
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

  // channelCount is the mode's DMX *footprint*, not how many channel entries
  // it has. Offsets can be sparse or start above zero, and the render loop
  // clears `for (c < channelCount)` before writing by offset — so a count
  // smaller than the highest offset leaves channels written but never
  // cleared, latching stale values until master blackout. It also drives
  // auto-addressing and the patch table's overlap detection. A 16-bit
  // channel's fine byte is part of it.
  const channelCount = channelList.reduce((max, ch) => Math.max(max, ch.offset), -1) + 1;

  // The channels the engine writes every frame: a bar's own dimmer and strobe
  // and its cells' lights, or a single light's dimmer, strobe and colours. The
  // strobe is written only while it flashes, so it sits at its default between.
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
  // Everything else sits at its default, held open or at full where the default is dark.
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
  if (cellKeys.length) result.cells = cellKeys.map((key, i) => ({ name: String(key).slice(0, 64), channelMap: cellMaps[i] }));
  if (held.size) result.defaults = [...held].sort((a, b) => a[0] - b[0]).map(([offset, value]): ChannelDefault => ({ offset, value }));
  if (warnings.length) result.warnings = warnings;
  return result;
}

/**
 * Decompress one zip entry to a UTF-8 string, refusing once more than `limit`
 * bytes have come out.
 */
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
