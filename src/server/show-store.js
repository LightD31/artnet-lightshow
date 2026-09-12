'use strict';

const fs = require('fs');
const path = require('path');

const {
  state, universeOf, maxBrightnessOf, setDefaultUniverse,
} = require('./state');
const { resizeFixtureBuffers } = require('./engine');
const {
  BUILTIN_PROFILE_ID,
  BUILTIN_PROFILE_IDS,
  isBuiltinProfile,
  MAX_FIXTURES,
  UNIVERSE_SIZE,
  endChannel,
  fitsInUniverse,
  registerProfile,
  clearNonBuiltinProfiles,
  listProfiles,
} = require('./profiles');
const { MAX_UNIVERSES } = require('./universes');
const { showSchema, validate } = require('./validation');

/**
 * The patch, saved for you.
 *
 * What the rig *is* — where each fixture is addressed, which universe it sits
 * on, what profile it runs, its brightness trim — used to live only in memory.
 * Every restart put the rig back to four twelve-channel pars at 1, 13, 25 and
 * 37, and the only way out was to have remembered to export a show file and
 * load it again. A patch is not a preference an operator re-enters at each
 * boot: it is a description of the building.
 *
 * So every change to the patch writes config/show.json, and the server loads it
 * at boot. The file is exactly the show file the settings page exports, so the
 * two are interchangeable: a saved show can be hand-edited, copied to another
 * machine, or dropped in as show.json.
 *
 * Deliberately NOT saved here: the look on stage (tempo, pattern, palette,
 * master, strobe, per-fixture overrides). That is what cues are for, and a rig
 * that came back from a restart holding a blackout — or a strobe — because that
 * is what was on stage when the power went would be a worse rig.
 */

// Writes are debounced: dragging an address spinner emits on every step, and
// the render loop should not be interleaved with a file write per pixel moved.
const SAVE_DEBOUNCE_MS = 400;

function badShow(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** The rig as a portable show file — the body of GET /api/show. */
function snapshotShow() {
  const profiles = listProfiles();
  return {
    artnet: { ...state.artnet },
    // Only the profiles that were imported. The built-ins are on every server
    // already, so shipping them in the file would mean a show loaded onto a
    // newer build quietly reinstating an older copy of them.
    profiles: Object.values(profiles).filter((p) => !isBuiltinProfile(p.id)),
    fixtures: state.fixtures.map((f) => ({
      label: f.label,
      address: f.address,
      universe: universeOf(f),
      profileId: f.profileId,
      maxBrightness: maxBrightnessOf(f),
    })),
  };
}

/**
 * Put a show on the rig: its imported profiles, its Art-Net defaults, its
 * patch. Throws an Error carrying `status` when the show does not fit, having
 * changed nothing.
 *
 * Resolve the incoming show against the profiles it *brings*, before touching
 * live state. Loading a show is otherwise the one path that can half-apply: the
 * old code swapped the profile registry first, so a show that failed later left
 * the rig on a profile set no fixture referenced. It was also the one path that
 * skipped the universe-bounds check the socket handler enforces, silently
 * dropping the overhanging channels.
 */
function applyShow(rawShow) {
  const show = validate(showSchema, rawShow, 'show');
  const hasFixtures = Array.isArray(show.fixtures) && show.fixtures.length > 0;
  if (hasFixtures && show.fixtures.length > MAX_FIXTURES) {
    throw badShow(`Show has ${show.fixtures.length} fixtures, more than the ${MAX_FIXTURES} supported`);
  }

  const incoming = Object.create(null);
  // Every built-in, not just the fallback: a show whose fixtures sit on the
  // Hue lamp profiles carries no copy of them, so resolving against the
  // fallback alone would silently land those fixtures on a 12-channel par.
  for (const id of BUILTIN_PROFILE_IDS) incoming[id] = listProfiles()[id];
  if (Array.isArray(show.profiles)) {
    for (const p of show.profiles) if (p && p.id) incoming[p.id] = p;
  }

  // A show file carries its own default universe, and the fixtures in it are
  // resolved against that rather than the one the rig happens to be on.
  const showUniverse = (show.artnet && show.artnet.universe !== undefined)
    ? show.artnet.universe : state.artnet.universe;

  let next = null;
  if (hasFixtures) {
    next = show.fixtures.map((f, i) => ({
      id: i,
      label: f.label || `Fixture ${i + 1}`,
      address: f.address || 1,
      // Shows saved before multi-universe carry no universe at all: those
      // fixtures belong on the show's own universe, where they used to be.
      universe: f.universe !== undefined ? f.universe : showUniverse,
      profileId: incoming[f.profileId] ? f.profileId : BUILTIN_PROFILE_ID,
      maxBrightness: f.maxBrightness !== undefined ? f.maxBrightness : 255,
      override: null,
    }));
    for (const fix of next) {
      const chCount = incoming[fix.profileId].channelCount;
      if (!fitsInUniverse(fix.address, chCount)) {
        throw badShow(`"${fix.label}" at address ${fix.address} needs ${chCount} channels and would end at `
          + `${endChannel(fix.address, chCount)}, past the ${UNIVERSE_SIZE}-channel universe`);
      }
    }
    const spanned = new Set([showUniverse, ...next.map((f) => f.universe)]);
    if (spanned.size > MAX_UNIVERSES) {
      throw badShow(`Show spans ${spanned.size} universes, more than the ${MAX_UNIVERSES} this server transmits`);
    }
  }

  // Everything checked out — now apply.
  if (Array.isArray(show.profiles)) {
    clearNonBuiltinProfiles();
    show.profiles.forEach((p) => { if (p && p.id) registerProfile(p); });
  }
  if (show.artnet) {
    const { universe, ...rest } = show.artnet;
    Object.assign(state.artnet, rest);
    if (universe !== undefined) {
      // With a fixture list the show already says where every fixture goes, so
      // assign the default directly; dragging the old default's occupants along
      // would fight it. Without one, this is the Art-Net panel's "move the rig"
      // semantics.
      if (next) state.artnet.universe = universe;
      else setDefaultUniverse(universe);
    }
  }
  if (next) {
    state.fixtures = next;
    resizeFixtureBuffers();
  }
  return show;
}

class ShowStore {
  constructor(file, { debounceMs = SAVE_DEBOUNCE_MS } = {}) {
    this.file = file;
    this._debounceMs = debounceMs;
    this._timer = null;
    // What the file holds, as written. Lets a burst of changes that cancel out
    // — or a broadcast that touched nothing — skip the write entirely.
    this._saved = null;
  }

  /**
   * Read show.json. A missing file is normal: a rig that has never been patched
   * runs the default four pars. A corrupt one is moved aside rather than
   * deleted, so a hand-edit that went wrong is recoverable, and the show still
   * starts on the defaults.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[show] cannot read ${this.file}: ${err.message} — starting on the default patch`);
      }
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      return this._quarantine(`invalid JSON (${err.message})`);
    }
  }

  /**
   * Put the saved patch back on the rig. Called once at boot, before the engine
   * starts, so the first frame goes out to the real rig rather than to four
   * default pars.
   *
   * A saved show that no longer fits — an address past the end of a universe
   * after someone hand-edited it, more universes than this server transmits —
   * is moved aside rather than loaded half-way. Coming up on the default patch
   * beats refusing to start, and moving it aside means the operator's file is
   * still there instead of being overwritten by the first change they make.
   */
  restore() {
    const show = this.load();
    if (!show) return false;
    try {
      applyShow(show);
    } catch (err) {
      this._quarantine(`does not fit this rig (${err.message})`);
      return false;
    }
    // In sync with the file now, so no change-driven write repeats it.
    this._saved = this._serialise();
    return true;
  }

  _quarantine(reason) {
    const backup = `${this.file}.invalid-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      console.warn(`[show] ${this.file}: ${reason}`);
      console.warn(`[show] moved it to ${backup} and started on the default patch`);
    } catch (err) {
      console.warn(`[show] ${this.file}: ${reason} (could not move aside: ${err.message})`);
    }
    return null;
  }

  _serialise() {
    return `${JSON.stringify(snapshotShow(), null, 2)}\n`;
  }

  /**
   * Note that the patch changed. The write lands a moment later, so a drag that
   * emits thirty edits writes once.
   */
  scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, this._debounceMs);
    // A pending save must not hold the process open; shutdown flushes it.
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Write the patch now, if it differs from what the file already holds.
   * Returns true when it wrote. A failure is reported and swallowed: the
   * operator is mid-show, and a rig that stops doing lights because a disk is
   * full is worse than one whose patch has to be re-entered.
   */
  save() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const body = this._serialise();
    if (body === this._saved) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
      this._saved = body;
      return true;
    } catch (err) {
      console.warn(`[show] could not save the patch to ${this.file}: ${err.message}`);
      return false;
    }
  }
}

// Fixed location, for the same reason settings.json and cues.json are: it is
// how you *find* the patch, not itself a setting. Tests build their own store.
const SHOW_FILE = path.join(__dirname, '..', '..', 'config', 'show.json');
const showStore = new ShowStore(SHOW_FILE);

module.exports = {
  showStore,
  ShowStore,
  SHOW_FILE,
  snapshotShow,
  applyShow,
};
