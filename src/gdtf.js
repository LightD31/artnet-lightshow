'use strict';

const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const { EMITTERS, MAX_CELLS_PER_FIXTURE } = require('./shared/rig');

// Upper bound on the decompressed description.xml. Real fixture definitions are
// a few hundred KB at most; anything past this is a zip bomb, not a fixture.
const MAX_DESCRIPTION_BYTES = 16 * 1024 * 1024;

// Map GDTF attribute names to our internal channel attributes
const ATTR_MAP = {
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
function attributeBase(attrString) {
  // GDTF attributes can be dotted like "Dimmer.Dimmer.Dimmer 1"
  // Take the first segment
  return attrString ? attrString.split('.')[0].replace(/\s+\d+$/, '') : '';
}

function resolveAttribute(attrString) {
  if (!attrString) return null;
  return ATTR_MAP[attributeBase(attrString)] || ATTR_MAP[attrString] || null;
}

/**
 * Parse a GDTF file buffer and extract fixture profiles (one per DMX mode).
 * @param {Buffer} fileBuffer - The .gdtf file contents
 * @returns {Promise<{name, manufacturer, modes: Array<{modeName, channelCount, channelMap, channelList}>}>}
 */
async function parseGDTF(fileBuffer) {
  const zip = await JSZip.loadAsync(fileBuffer);

  // Find description.xml (case-insensitive)
  let descFile = null;
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
  const declaredSize = descFile._data && descFile._data.uncompressedSize;
  if (Number.isFinite(declaredSize) && declaredSize > MAX_DESCRIPTION_BYTES) {
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
    isArray: (name) => ['DMXMode', 'DMXChannel', 'LogicalChannel', 'ChannelFunction', 'GeometryReference', 'Break'].includes(name),
  });

  const parsed = parser.parse(xmlContent);

  // Navigate the GDTF XML structure
  const fixtureType = parsed.GDTF?.FixtureType || parsed.FixtureType;
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
function indexGeometries(root) {
  const topOf = new Map();
  const references = [];
  const visit = (node, top) => {
    for (const [key, value] of Object.entries(node || {})) {
      if (key.startsWith('@_') || key === '#text') continue;
      for (const child of [].concat(value)) {
        if (!child || typeof child !== 'object') continue;
        const name = child['@_Name'];
        const ancestor = top ?? name;
        if (name != null && !topOf.has(name)) topOf.set(name, ancestor);
        if (key === 'GeometryReference') {
          references.push({
            name,
            template: child['@_Geometry'],
            breaks: [].concat(child.Break || []).map((b) => ({
              dmxBreak: parseInt(b['@_DMXBreak'] ?? '1', 10) || 1,
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
function dmxOffset(raw) {
  const text = String(raw ?? '1');
  if (text.includes('.')) {
    const [universe, address] = text.split('.').map((v) => parseInt(v, 10));
    return (Math.max(1, universe || 1) - 1) * 512 + (address || 1);
  }
  return parseInt(text, 10) || 1;
}

/** The attribute and a display name for one DMXChannel, as the flat parser read them. */
function describeChannel(ch, fallbackName) {
  const logical = [].concat(ch.LogicalChannel || []);
  let attrName = null;
  let displayName = fallbackName;
  if (logical.length > 0) {
    const lc = logical[0];
    attrName = lc['@_Attribute'] || null;
    const cf = [].concat(lc.ChannelFunction || []);
    if (cf.length > 0 && cf[0]['@_Attribute']) {
      attrName = attrName || cf[0]['@_Attribute'];
      if (cf[0]['@_Name']) displayName = cf[0]['@_Name'];
    }
  }
  return { attrName, displayName };
}

/**
 * One DMX mode as a profile: its footprint, its fixture-level channel map, and
 * — for a fixture that is several lights — its cells, in the order they sit.
 */
function parseMode(mode, geometries) {
  const modeName = mode['@_Name'] || 'Default';
  const root = mode['@_Geometry'] || null;
  const channels = mode.DMXChannels?.DMXChannel || [];
  const warnings = [];
  const entries = [];            // { key, bytes: [coarse, fine…] (0-based), attrName, displayName, order }

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

    // A channel on a geometry that is placed by references is a template:
    // one copy per reference, at that reference's offset.
    const template = geometries.topOf.get(geometry);
    const refs = template ? geometries.references.filter((r) => r.template === template) : [];
    const instances = refs.length
      ? refs.map((r) => {
        // "Overwrite" takes the reference's own break — by convention its last.
        const b = channelBreak === 'Overwrite'
          ? r.breaks[r.breaks.length - 1]
          : r.breaks.find((x) => x.dmxBreak === (parseInt(channelBreak, 10) || 1));
        return b ? { key: r.name, shift: b.offset - 1, dmxBreak: b.dmxBreak } : null;
      }).filter(Boolean)
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
      entries.push({ key, bytes: addressed, attrName, displayName, order: idx });
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

  // Cells: the geometries that make light, if there are at least two of them.
  // The mode's own geometry is the fixture as a whole, never a cell.
  const firstAddress = new Map();
  for (const e of entries) {
    if (!e.key || e.key === root || !EMITTERS.includes(e.attribute)) continue;
    firstAddress.set(e.key, Math.min(firstAddress.get(e.key) ?? Infinity, e.bytes[0]));
  }
  let cellKeys = [...firstAddress.keys()].sort((a, b) => firstAddress.get(a) - firstAddress.get(b));
  if (cellKeys.length < 2) cellKeys = [];
  if (cellKeys.length > MAX_CELLS_PER_FIXTURE) {
    warnings.push(`${cellKeys.length} cells is more than the ${MAX_CELLS_PER_FIXTURE} a fixture may have; only the first are used`);
    cellKeys = cellKeys.slice(0, MAX_CELLS_PER_FIXTURE);
  }
  const cellIndex = new Map(cellKeys.map((key, i) => [key, i]));

  const channelList = [];
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

  // Only the first occurrence of each attribute is driven, per cell and for
  // the fixture as a whole; a 16-bit dimmer's fine byte is its dimmerFine.
  const mapInto = (map, e) => {
    if (!e.attribute || e.attribute in map) return;
    map[e.attribute] = e.bytes[0];
    if (e.attribute === 'dimmer' && e.bytes.length > 1 && !('dimmerFine' in map)) map.dimmerFine = e.bytes[1];
  };
  const inOrder = [...entries].sort((a, b) => a.order - b.order || a.bytes[0] - b.bytes[0]);
  const channelMap = {};
  const cellMaps = cellKeys.map(() => ({}));
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

  const result = { modeName, channelCount, channelMap, channelList };
  if (cellKeys.length) result.cells = cellKeys.map((key, i) => ({ name: String(key).slice(0, 64), channelMap: cellMaps[i] }));
  if (warnings.length) result.warnings = warnings;
  return result;
}

/**
 * Decompress one zip entry to a UTF-8 string, refusing once more than `limit`
 * bytes have come out.
 */
function inflateCapped(entry, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const stream = entry.internalStream('uint8array');
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { stream.pause(); } catch (_) { /* already stopped */ }
      reject(err);
    };
    stream
      .on('data', (chunk) => {
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

module.exports = { parseGDTF, inflateCapped };
