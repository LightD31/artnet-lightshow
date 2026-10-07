/** A look colour: red, green and blue, and the extra dies, each 0–255. */
export interface Colour {
  r: number;
  g: number;
  b: number;
  w?: number;
  a?: number;
  uv?: number;
}

/** Every die resolved to the value it is driven at, 0–255. */
export interface EmitterLevels {
  r: number;
  g: number;
  b: number;
  w: number;
  a: number;
  uv: number;
}

/** A colour with every die present — what a burst or an override drives. */
export type FullColour = EmitterLevels;

/** Zero-based channel offsets; imported attributes outside these names are retained but not driven. */
export interface ChannelMap {
  dimmer?: number;
  dimmerFine?: number;
  strobe?: number;
  red?: number;
  green?: number;
  blue?: number;
  white?: number;
  amber?: number;
  uv?: number;
  warmWhite?: number;
  coolWhite?: number;
  [attribute: string]: number | undefined;
}

/** One cell of a fixture that is more than one light (an LED bar). */
export interface ProfileCell {
  name?: string;
  channelMap: ChannelMap;
  /** Where the cell is in its profile's grid, counted from 0 (column, row). */
  at?: GridPoint;
}

/** A column and a row of a grid, counted from 0. */
export interface GridPoint {
  x: number;
  y: number;
}

/** A panel's cells in rows and columns: an LED matrix. */
export interface Grid {
  columns: number;
  rows: number;
}

/** One channel of a profile, for listing and labelling. */
export interface ChannelListEntry {
  offset: number;
  name: string;
  attribute: string;
  /** Which cell the channel drives, on a bar. */
  cell?: number;
}

/** Values for undriven channels, such as an open shutter or full dimmer. */
export interface ChannelDefault {
  offset: number;
  value: number;
}

/** What a kind of fixture is, channel by channel. */
export interface Profile {
  id: string;
  name: string;
  manufacturer?: string;
  modeName?: string;
  /** The fixture's DMX footprint. */
  channelCount: number;
  channelMap: ChannelMap;
  channelList?: ChannelListEntry[];
  /** An LED bar's cells, in the order they sit along it (2 or more). */
  cells?: ProfileCell[];
  /** A panel: the cells in rows and columns rather than along a line. */
  grid?: Grid;
  /** Undriven channels that must not sit at 0, written under every frame. */
  defaults?: ChannelDefault[];
  /** Grid zones use bar programs instead of panel images. */
  zoned?: boolean;
  [key: string]: unknown;
}

/** A position on the stage plot, in percent of its width and depth. */
export interface Point {
  x: number;
  y: number;
  /** How high in the room, 0 (the floor) to 100 (the ceiling); mid-room when unset. */
  height?: number;
}

/** A bar's line on the stage plot: its length, and its angle in degrees. */
export interface Geometry {
  length: number;
  angle: number;
}

/** A fixture pinned by hand, over whatever the look is doing. */
export interface Override {
  enabled: boolean;
  r: number;
  g: number;
  b: number;
  w: number;
  a?: number;
  uv?: number;
  dim?: number;
  strobe?: number;
  blackout?: boolean;
}

/** What the stage plot and the pattern layer need to know of a fixture. */
export interface StageFixture {
  position?: Point | null;
  group?: string | null;
  geometry?: Geometry | null;
  profileId?: string;
  /** Where its universes go (a Fixture's `output`): a Hue lamp is never flashed. */
  output?: { protocol: string } | null;
  /** A Hue lamp, or a light that follows one, already resolved (the engine's render fixture). */
  hue?: boolean;
}

/** A fixture in the patch. */
export interface Fixture extends StageFixture {
  id: number;
  label: string;
  /** 1-based DMX address; the server's own for a fixture with no DMX address. */
  address: number;
  universe?: number;
  profileId: string;
  maxBrightness?: number;
  override?: Override | null;
  /** Device-specific output; Hue has no transmitted DMX universe. */
  output?: FixtureOutput | null;
}

/** A fixture sent to a device of its own rather than on the rig's universes. */
export type FixtureOutput = DdpOutput | OpenRgbOutput | HueOutput;

/** DDP pixels: `at` starts the segment; `rowStride` is panel width; `areas` holds column/row/width/height zones. */
export interface DdpOutput {
  protocol: 'ddp';
  host: string;
  port?: number;
  at?: number;
  rowStride?: number;
  leds?: number;
  columns?: number;
  areas?: [number, number, number, number][];
}

/** OpenRGB resolves the saved device by name when device indices change. */
export interface OpenRgbOutput {
  protocol: 'openrgb';
  host: string;
  port?: number;
  device: number;
  name?: string;
  leds: number;
}

/** Bridge and entertainment-area channel; legacy shows migrate to the first bridge. */
export interface HueOutput {
  protocol: 'hue';
  bridge: string;
  channel: number;
}

/** Expression values are normalized to 0–1. */
export interface Expression {
  level: number;
  bass: number;
  vocal: number;
  air: number;
  width: number;
  motion: number;
  decay: number;
}

/** What a show asks the expression channel for; any key may be missing. */
export type ShowDynamics = Partial<Expression>;

/** Levels and decaying drum hits at pixel rate, 0–1; unavailable stems are absent. */
export interface PulseReading {
  mix: number;
  drums?: number;
  bass?: number;
  vocals?: number;
  other?: number;
  kick: number;
  snare: number;
  hats: number;
  /** Normalized drum-lane intensity; present only for detector version 2 or newer. */
  groove?: number;
}

/** How a pixel effect is laid over the cells of LED bars. */
export type PixelMap = 'stage' | 'bar' | 'mirror';

/** One DMX mode of an imported fixture (GDTF or OFL), ready to become a profile. */
export interface ImportedMode {
  modeName: string;
  channelCount: number;
  channelMap: ChannelMap;
  channelList: ChannelListEntry[];
  cells?: ProfileCell[];
  grid?: Grid;
  defaults?: ChannelDefault[];
  /** What the import could not carry over, in words an operator can act on. */
  warnings?: string[];
}

/** A fixture file, read: its name, its maker and every mode it defines. */
export interface ImportedFixture {
  name: string;
  manufacturer: string;
  modes: ImportedMode[];
  /** Modes the import had to leave out, and why. */
  warnings?: string[];
}
