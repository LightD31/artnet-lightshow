'use strict';

const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

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

function resolveAttribute(attrString) {
  if (!attrString) return null;
  // GDTF attributes can be dotted like "Dimmer.Dimmer.Dimmer 1"
  // Take the first segment
  const base = attrString.split('.')[0].replace(/\s+\d+$/, '');
  return ATTR_MAP[base] || ATTR_MAP[attrString] || null;
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

  const xmlContent = await descFile.async('string');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['DMXMode', 'DMXChannel', 'LogicalChannel', 'ChannelFunction'].includes(name),
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

  const modes = dmxModes.map(mode => {
    const modeName = mode['@_Name'] || 'Default';
    const channels = mode.DMXChannels?.DMXChannel || [];

    const channelList = [];
    const channelMap = {};

    channels.forEach((ch, idx) => {
      const offset = ch['@_DMXBreak'] === 'Overwrite' ? idx : (parseInt(ch['@_Offset']) || idx + 1) - 1;
      // Get the logical channel to determine attribute
      const logical = ch.LogicalChannel;
      const logicalArr = Array.isArray(logical) ? logical : (logical ? [logical] : []);

      let attrName = null;
      let displayName = ch['@_Geometry'] || `Channel ${offset + 1}`;

      if (logicalArr.length > 0) {
        const lc = logicalArr[0];
        attrName = lc['@_Attribute'] || null;

        // Try channel function name for display
        const cf = lc.ChannelFunction;
        const cfArr = Array.isArray(cf) ? cf : (cf ? [cf] : []);
        if (cfArr.length > 0 && cfArr[0]['@_Attribute']) {
          attrName = attrName || cfArr[0]['@_Attribute'];
          if (cfArr[0]['@_Name']) displayName = cfArr[0]['@_Name'];
        }
      }

      const attribute = resolveAttribute(attrName);

      channelList.push({
        offset,
        name: displayName,
        attribute: attribute || attrName || 'unknown',
        gdtfAttribute: attrName,
      });

      // Only map the first occurrence of each attribute
      if (attribute && !(attribute in channelMap)) {
        channelMap[attribute] = offset;
      }
    });

    // Sort by offset
    channelList.sort((a, b) => a.offset - b.offset);

    // channelCount is the mode's DMX *footprint*, not how many channel entries
    // it has. Offsets can be sparse or start above zero, and the render loop
    // clears `for (c < channelCount)` before writing by offset — so a count
    // smaller than the highest offset leaves channels written but never
    // cleared, latching stale values until master blackout. It also drives
    // auto-addressing and the patch table's overlap detection.
    const maxOffset = channelList.reduce((max, ch) => Math.max(max, ch.offset), -1);
    const channelCount = maxOffset + 1;

    return {
      modeName,
      channelCount,
      channelMap,
      channelList,
    };
  });

  return { name, manufacturer, modes };
}

module.exports = { parseGDTF };
