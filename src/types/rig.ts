/**
 * The shapes the rig is described in: colours, fixture profiles, fixtures on
 * the stage plot, and the music's expression channel.
 *
 * Types only — nothing here exists at runtime — so both the server and the
 * browser bundle can import it. The server's zod schemas (server/validation.ts)
 * are what check that data arriving from outside actually has these shapes.
 */

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

/**
 * Which channel, counted from the fixture's first, does what. Offsets are
 * 0-based. The names below are the ones the engine drives; a profile may name
 * others (from a GDTF or OFL import), which are kept but not driven.
 */
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

/**
 * A channel the show does not drive, and the value it sits at instead of 0:
 * a shutter whose 0 is closed, a dimmer the show leaves at full.
 */
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
  [key: string]: unknown;
}

/** A position on the stage plot, in percent of its width and depth. */
export interface Point {
  x: number;
  y: number;
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
}

/** A fixture in the patch. */
export interface Fixture extends StageFixture {
  id: number;
  label: string;
  /** 1-based DMX address. */
  address: number;
  universe?: number;
  profileId: string;
  maxBrightness?: number;
  override?: Override | null;
  /** Where its universes go, when not Art-Net and sACN: a WLED over DDP. */
  output?: FixtureOutput | null;
}

/** A fixture sent to a device of its own rather than on the rig's universes. */
export interface FixtureOutput {
  protocol: 'ddp';
  host: string;
  port?: number;
}

/**
 * The music's expression channel, each 0–1: how loud, how much bass and voice
 * and air, how wide, how fast it moves, how long it decays.
 */
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
