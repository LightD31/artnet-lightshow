import { signal, computed, batch } from '@preact/signals';

// Per-key signals avoid rerendering unrelated controls when another domain changes.
export function createStore() {
  const fields = new Map();
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

  // Reading all subscribes to every key, so narrow controls should read individual fields.
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
