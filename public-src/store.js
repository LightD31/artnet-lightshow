import { signal, computed, batch } from '@preact/signals';

/**
 * The live state on the page, one signal per key (protocol v2, see
 * src/server/protocol.ts).
 *
 * The server sends a snapshot on connect and then only the keys that changed,
 * grouped by domain, each domain's patches numbered. A component that reads
 * `field('masterDimmer')` re-renders when the master moves and not when the
 * Spotify status ticks over — where every component used to re-render on
 * every push, because every push was the whole state.
 *
 * A patch that is not the next one for its domain means something was
 * missed; `applyPatch` says so and the caller asks for a snapshot.
 */
export function createStore() {
  const fields = new Map();
  // Bumped when a key appears or goes, so `all` knows to look again.
  const shape = signal(0);
  let versions = null;

  const field = (key) => {
    let sig = fields.get(key);
    if (!sig) {
      sig = signal(undefined);
      fields.set(key, sig);
    }
    return sig;
  };

  const set = (key, value) => {
    const existed = fields.has(key) && fields.get(key).peek() !== undefined;
    field(key).value = value;
    return !existed;
  };

  // Everything, as one object, for the components that want the lot. Reading
  // it subscribes to every key; a component that can say which keys it needs
  // reads those instead.
  const all = computed(() => {
    shape.value;
    const out = {};
    for (const [key, sig] of fields) {
      const value = sig.value;
      if (value !== undefined) out[key] = value;
    }
    return out;
  });

  return {
    field,
    all,

    /** The whole state and the version each domain is at. */
    applySnapshot({ versions: v, state }) {
      batch(() => {
        let added = false;
        for (const [key, value] of Object.entries(state || {})) added = set(key, value) || added;
        for (const [key, sig] of fields) {
          if (!(key in (state || {})) && sig.peek() !== undefined) {
            sig.value = undefined;
            added = true;
          }
        }
        if (added) shape.value++;
      });
      versions = { ...(v || {}) };
    },

    /**
     * One domain's changes. 'ok' when applied; 'stale' for one already seen;
     * 'gap' when one was missed, or no snapshot has arrived yet — the caller
     * should ask for a snapshot.
     */
    applyPatch({ d, v, set: values, del }) {
      if (!versions || !Number.isInteger(v)) return 'gap';
      const at = versions[d] ?? 0;
      if (v <= at) return 'stale';
      if (v !== at + 1) return 'gap';
      batch(() => {
        let changed = false;
        for (const [key, value] of Object.entries(values || {})) changed = set(key, value) || changed;
        for (const key of del || []) {
          if (fields.has(key) && fields.get(key).peek() !== undefined) {
            fields.get(key).value = undefined;
            changed = true;
          }
        }
        if (changed) shape.value++;
      });
      versions[d] = v;
      return 'ok';
    },

    /** Merge whole-state pushes (protocol 1) or local updates in. */
    merge(values) {
      batch(() => {
        let added = false;
        for (const [key, value] of Object.entries(values || {})) added = set(key, value) || added;
        if (added) shape.value++;
      });
    },

    versions: () => (versions ? { ...versions } : null),
  };
}
