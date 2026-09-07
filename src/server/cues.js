'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');

const { state, getFixtureCount } = require('./state');
const { applyPatch, applyOverride } = require('./patch');
const { overrideSchema } = require('./validation');
const { COLOR_PRESETS } = require('./presets');

/**
 * Named looks, saved and recalled.
 *
 * A cue is a snapshot of everything that decides what the rig is doing right
 * now — tempo, pattern, palette, master, strobe, and each fixture's override —
 * captured under a name so it can be put back on stage in one press. That is
 * what a console's cue stack is for, and without one the only way back to a
 * look you liked was to rebuild it by hand while the room watched.
 *
 * Stored in config/cues.json next to the settings. A corrupt file is moved
 * aside rather than deleted, and the show still starts.
 */

// A cue list is a set list, not a database. The cap keeps a stuck client from
// growing the file (and the state broadcast) without bound.
const MAX_CUES = 128;

const colorIdx = z.number().int().min(0).max(COLOR_PRESETS.length - 1);

// What a cue restores. Deliberately the operator-facing look and nothing else:
// no fixture patch, no Art-Net target, no analysis. Recalling a cue must never
// re-address the rig or move it to another universe mid-show.
const lookSchema = z.object({
  bpm: z.number().int().min(20).max(300),
  beatDivision: z.number().int().min(1).max(16),
  running: z.boolean(),
  pattern: z.string().min(1).max(64),
  colorA: colorIdx,
  colorB: colorIdx,
  colorC: colorIdx,
  colorD: colorIdx,
  masterDimmer: z.number().int().min(0).max(255),
  masterBlackout: z.boolean(),
  strobeSpeed: z.number().int().min(0).max(255),
  strobeFunction: z.string().min(1).max(64),
  energyOverride: z.union([z.string().min(1).max(64), z.null()]),
  // One entry per fixture, positional. null means "no override on that fixture".
  overrides: z.array(z.union([overrideSchema, z.null()])).max(64),
}).strict();

const cueSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  look: lookSchema,
}).strict();

const fileSchema = z.object({
  cues: z.array(cueSchema).max(MAX_CUES),
}).strict();

/**
 * The body of POST /api/cues and PUT /api/cues/:id.
 *
 * On create, an absent look means "capture what is on stage now". On update,
 * an absent look leaves the stored one alone, so renaming a cue never quietly
 * overwrites its look — `recapture` is how you ask for that, and it is a
 * separate flag because the client only holds cue *summaries* and so cannot
 * send a complete look back. A caller may still send one outright, which is
 * how a cue exported from one rig loads onto another.
 */
const cueWriteSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  look: lookSchema.optional(),
  recapture: z.boolean().optional(),
}).strict();

const reorderSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).max(MAX_CUES),
}).strict();

/** POST /api/cues/restore: put a just-deleted cue back where it was. */
const cueRestoreSchema = z.object({
  cue: cueSchema,
  index: z.number().int().min(0).max(MAX_CUES).optional(),
}).strict();

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Everything on stage right now, as a cue look. */
function captureLook() {
  return {
    bpm: state.bpm,
    beatDivision: state.beatDivision,
    running: state.running,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    colorC: state.colorC,
    colorD: state.colorD,
    masterDimmer: state.masterDimmer,
    masterBlackout: state.masterBlackout,
    strobeSpeed: state.strobeSpeed,
    strobeFunction: state.strobeFunction,
    energyOverride: state.energyOverride,
    overrides: state.fixtures.map((f) => (f.override ? { ...f.override } : null)),
  };
}

/**
 * Put a look back on stage.
 *
 * The overrides go on after the patch so a cue captured with a fixture
 * overridden reproduces exactly that, and fixtures the cue has nothing to say
 * about are *cleared* rather than left holding whatever the last look put on
 * them — a cue is the whole rig, not a partial edit.
 */
function recallLook(look) {
  const { overrides, ...patch } = look;
  applyPatch(patch);

  const count = getFixtureCount();
  for (let i = 0; i < count; i++) {
    applyOverride(i, (overrides && overrides[i]) || null);
  }
}

class CueStore {
  constructor(file) {
    this.file = file;
    this._cues = [];
  }

  /**
   * Read cues.json. A missing file is normal (no cues saved yet). A corrupt one
   * is moved aside rather than deleted, so a hand-edit that went wrong is
   * recoverable and the show still starts.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[cues] cannot read ${this.file}: ${err.message} — starting with no cues`);
      }
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this._quarantine(`invalid JSON (${err.message})`);
    }

    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
      return this._quarantine(detail);
    }

    this._cues = result.data.cues;
    return this;
  }

  _quarantine(reason) {
    const backup = `${this.file}.invalid-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      console.warn(`[cues] ${this.file}: ${reason}`);
      console.warn(`[cues] moved it to ${backup} and started with no cues`);
    } catch (err) {
      console.warn(`[cues] ${this.file}: ${reason} (could not move aside: ${err.message})`);
    }
    this._cues = [];
    return this;
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ cues: this._cues }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  /** Every cue, in show order, with its full look. */
  list() {
    return this._cues.map((c) => JSON.parse(JSON.stringify(c)));
  }

  /**
   * The list the UI renders: identity plus enough to draw a swatch, without the
   * per-fixture overrides. A hundred full looks ride every state broadcast
   * otherwise, and the buttons never needed them.
   */
  summaries() {
    return this._cues.map((c) => ({
      id: c.id,
      name: c.name,
      updatedAt: c.updatedAt,
      pattern: c.look.pattern,
      bpm: c.look.bpm,
      colors: [c.look.colorA, c.look.colorB, c.look.colorC, c.look.colorD],
      blackout: c.look.masterBlackout,
    }));
  }

  get(id) {
    return this._cues.find((c) => c.id === id) || null;
  }

  /** Save a new cue. `look` defaults to what is on stage now. */
  create({ name, look }) {
    if (this._cues.length >= MAX_CUES) {
      const err = new Error(`Cue stack is full (${MAX_CUES} cues)`);
      err.status = 400;
      throw err;
    }
    const now = new Date().toISOString();
    const cue = {
      id: newId(),
      name: name || `Cue ${this._cues.length + 1}`,
      createdAt: now,
      updatedAt: now,
      look: lookSchema.parse(look || captureLook()),
    };
    this._cues.push(cue);
    this._persist();
    return cue;
  }

  /**
   * Rename a cue, re-capture it over the live look, or both. With neither
   * `recapture` nor `look`, the stored look is left alone — a rename must
   * never quietly overwrite it with whatever happens to be on stage.
   */
  update(id, { name, look, recapture }) {
    const cue = this.get(id);
    if (!cue) return null;
    if (name !== undefined) cue.name = name;
    if (recapture) cue.look = lookSchema.parse(captureLook());
    else if (look !== undefined) cue.look = lookSchema.parse(look);
    cue.updatedAt = new Date().toISOString();
    this._persist();
    return cue;
  }

  /**
   * Delete a cue and hand back what was removed, and from where.
   *
   * The caller needs both to offer an undo: re-creating a cue from its look
   * alone would give it a new id and drop it at the end of the stack, which is
   * not what "undo" means to someone who just deleted the wrong row.
   *
   * @returns {{cue, index}|null} null when the id is unknown.
   */
  remove(id) {
    const index = this._cues.findIndex((c) => c.id === id);
    if (index < 0) return null;
    const [cue] = this._cues.splice(index, 1);
    this._persist();
    return { cue, index };
  }

  /**
   * Put a removed cue back where it was, id intact.
   *
   * Idempotent on the id: pressing undo twice, or on a cue that has since been
   * re-created, must not end up with two rows claiming the same id.
   */
  insert(cue, index) {
    const parsed = cueSchema.parse(cue);
    if (this.get(parsed.id)) return null;
    if (this._cues.length >= MAX_CUES) {
      const err = new Error(`Cue stack is full (${MAX_CUES} cues)`);
      err.status = 400;
      throw err;
    }
    const at = Math.max(0, Math.min(this._cues.length, Number.isInteger(index) ? index : this._cues.length));
    this._cues.splice(at, 0, parsed);
    this._persist();
    return parsed;
  }

  /**
   * Reorder the stack. Ids not in the list keep their relative order at the
   * end, so a client working from a stale list cannot drop cues by omission.
   */
  reorder(ids) {
    const byId = new Map(this._cues.map((c) => [c.id, c]));
    const ordered = [];
    for (const id of ids) {
      const cue = byId.get(id);
      if (cue && !ordered.includes(cue)) ordered.push(cue);
    }
    for (const cue of this._cues) if (!ordered.includes(cue)) ordered.push(cue);
    this._cues = ordered;
    this._persist();
    return this._cues;
  }

  /** Put a stored cue on stage. Returns false when the id is unknown. */
  recall(id) {
    const cue = this.get(id);
    if (!cue) return false;
    recallLook(cue.look);
    return true;
  }

  // A failed write must not leave the process disagreeing with the file: a cue
  // the operator thinks is saved and isn't would come back missing after a
  // restart, mid-set.
  _persist() {
    try {
      this.save();
    } catch (err) {
      console.warn(`[cues] could not save ${this.file}: ${err.message}`);
      const wrapped = new Error(`Could not save cues: ${err.message}`);
      wrapped.status = 500;
      throw wrapped;
    }
  }
}

// Fixed location for the same reason settings.json is: it is how you *find* the
// cues, not itself a setting. Tests construct their own CueStore.
const CUES_FILE = path.join(__dirname, '..', '..', 'config', 'cues.json');
const cues = new CueStore(CUES_FILE).load();

module.exports = {
  cues,
  CUES_FILE,
  CueStore,
  MAX_CUES,
  lookSchema,
  cueSchema,
  cueWriteSchema,
  cueRestoreSchema,
  reorderSchema,
  captureLook,
  recallLook,
};
