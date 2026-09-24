import { useState } from 'preact/hooks';
import { settingsSig, saveSettings, at, post } from '../../setup-state.js';

/**
 * A group of stored settings with one Apply: every field laid out the same
 * way, with the same secret handling and the same restart badge.
 *
 * A field is `{ path, label, type, help?, note?, unit?, min?, max?,
 * options?, missing?, empty?, generate?, resets? }`:
 *
 *   type      'toggle' | 'number' | 'text' | 'secret' | 'select'
 *   options   (ctx, valueOf) → [{ value, label }] for a select
 *   missing   (value) → how to show a stored value the list no longer has
 *   note      (settingsData) → { ok, text } — what the server resolved, shown
 *             under the field ("Currently: …")
 *   resets    paths put back to '' when this one changes (a device list that
 *             depends on the source picked)
 *
 * `children` go under the Apply button — a list of what is on the network, a
 * connection's status — or above it with `childrenFirst`, when they are part
 * of what Apply saves (`collect`).
 *
 * A secret is never sent to the browser: the server says whether one is set,
 * the box is blank, and a value is sent only when one is typed. Clear sends
 * '' on its own.
 *
 * Edits are held here until Apply; what is not being edited follows the
 * server, so a save from another page shows up.
 */

const valueForInput = (field, value) => {
  if (field.type === 'toggle') return !!value;
  if (value === undefined || value === null) return '';
  return value;
};

export function SettingsSection({ id, title, desc, fields, ctx = {}, collect, dirtyExtra = false, onApply, stored, children, childrenFirst = false, footer }) {
  const data = settingsSig.value;
  const [draft, setDraft] = useState({});
  const [status, setStatus] = useState(null);   // { ok, text }
  const [shown, setShown] = useState({});       // secrets being shown in the clear (a generated token)
  const [busy, setBusy] = useState(false);
  const read = stored || ((path) => at(data && data.settings, path));

  const valueOf = (path) => (Object.hasOwn(draft, path) ? draft[path] : read(path));
  const edit = (field, value) => {
    const next = { ...draft, [field.path]: value };
    for (const other of field.resets || []) next[other] = '';
    setDraft(next);
    setStatus(null);
  };

  const dirty = dirtyExtra || Object.keys(draft).some((path) => {
    const field = fields.find((f) => f.path === path);
    return field && (field.type === 'secret' ? draft[path] !== '' : String(draft[path]) !== String(read(path) ?? ''));
  });

  /** The section's edits as `{ group: { key: value } }`, with `overrides` on top. */
  const patchOf = (overrides = {}) => {
    const patch = {};
    const put = (path, value) => {
      const [group, key] = path.split('.');
      patch[group] = patch[group] || {};
      patch[group][key] = value;
    };
    for (const field of fields) {
      if (Object.hasOwn(overrides, field.path)) { put(field.path, overrides[field.path]); continue; }
      if (!Object.hasOwn(draft, field.path)) continue;
      let value = draft[field.path];
      if (field.type === 'secret') {
        // Blank is "leave it": the stored value was never here to send back.
        if (!value) continue;
      } else if (field.type === 'number') {
        value = Number(value);
      } else if (field.type === 'toggle') {
        value = !!value;
      }
      put(field.path, value);
    }
    for (const [path, value] of Object.entries(collect ? collect() : {})) put(path, value);
    return patch;
  };

  const apply = async (overrides) => {
    setBusy(true);
    setStatus(null);
    const patch = patchOf(overrides);
    const res = onApply ? await onApply(patch) : await saveSettings(patch);
    setBusy(false);
    if (!res || !res.ok) {
      setStatus({ ok: false, text: (res && res.error) || 'Not saved' });
      return;
    }
    setDraft({});
    setShown({});
    const restarts = (res.pendingRestart || []).filter((k) => fields.some((f) => f.path === k));
    setStatus({ ok: true, text: restarts.length ? 'Saved — restart the server to apply' : 'Saved' });
  };

  const generate = async (field) => {
    const res = await post('/api/settings/token/suggest', {});
    if (!res.ok) return;
    // In the clear: it has to be copied into Companion and the extension. It
    // is not stored until Apply.
    setShown({ ...shown, [field.path]: true });
    edit(field, res.token);
  };

  const restartKeys = (data && data.restartKeys) || [];
  const pending = (data && data.pendingRestart) || [];

  return (
    <section class="panel setup-section" aria-labelledby={`section-${id}`} data-section={id}>
      <header class="panel-head">
        <h2 class="panel-title" id={`section-${id}`}>{title}</h2>
      </header>
      {desc && <p class="section-desc">{desc}</p>}
      <div class="setting-rows">
        {fields.map((field) => {
          const inputId = `set-${field.path}`;
          const helpId = field.help ? `${inputId}-help` : undefined;
          const value = valueOf(field.path);
          const isSet = !!(data && data.secrets && data.secrets[field.path]);
          const note = field.note ? field.note(data) : null;
          let control;
          if (field.type === 'toggle') {
            control = <input id={inputId} type="checkbox" checked={!!value} aria-describedby={helpId}
              onChange={(e) => edit(field, e.target.checked)} />;
          } else if (field.type === 'select') {
            const options = field.options ? field.options(ctx, valueOf) : [];
            const current = value ?? '';
            // A stored value the list no longer has is still shown, or the
            // control would claim the setting is something it is not.
            const known = options.some((o) => String(o.value) === String(current));
            control = (
              <select id={inputId} value={String(current)} aria-describedby={helpId} onChange={(e) => edit(field, e.target.value)}>
                {(!options.length || !known) && (
                  <option value={String(current)}>
                    {options.length ? (field.missing ? field.missing(current) : `${current} (not available)`) : (field.empty || 'none')}
                  </option>
                )}
                {options.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
              </select>
            );
          } else if (field.type === 'secret') {
            control = <input id={inputId} type={shown[field.path] ? 'text' : 'password'} autocomplete="new-password"
              value={valueForInput(field, draft[field.path])} aria-describedby={helpId}
              placeholder={isSet ? '•••••••• (leave blank to keep)' : 'not set'}
              onInput={(e) => edit(field, e.target.value)} />;
          } else {
            control = <input id={inputId} type={field.type === 'number' ? 'number' : 'text'} min={field.min} max={field.max}
              value={valueForInput(field, value)} aria-describedby={helpId} placeholder={field.placeholder}
              onInput={(e) => edit(field, e.target.value)} />;
          }
          const restart = restartKeys.includes(field.path);
          return (
            <div key={field.path} class="setting-row">
              <div class="setting-field">
                <label for={inputId}>{field.label}</label>
                <div class="setting-control">
                  {control}
                  {field.unit && <span class="setting-unit">{field.unit}</span>}
                  {field.type === 'secret' && (
                    <button type="button" class="btn sm" disabled={!isSet || busy} onClick={() => apply({ [field.path]: '' })}
                      aria-label={`Clear ${field.label}`}>Clear</button>
                  )}
                  {field.generate && <button type="button" class="btn sm" onClick={() => generate(field)}>Generate</button>}
                </div>
                {restart && (
                  <span class={`setting-badge ${pending.includes(field.path) ? 'pending' : ''}`}>
                    {pending.includes(field.path) ? 'restart to apply' : 'restart'}
                  </span>
                )}
              </div>
              {field.help && <p class="setting-help" id={helpId}>{field.help}</p>}
              {note && <p class={`setting-help setting-note ${note.ok ? '' : 'warn'}`}>{note.text}</p>}
            </div>
          );
        })}
      </div>
      {childrenFirst && children}
      {(fields.length > 0 || collect) && (
        <div class="setting-actions">
          <button type="button" class="btn active" disabled={busy || !dirty} onClick={() => apply()}>Apply</button>
          {status && <span class={`import-status ${status.ok ? 'success' : 'error'}`} role="status">{status.text}</span>}
          {!status && dirty && <span class="import-status">Not applied yet</span>}
        </div>
      )}
      {!childrenFirst && children}
      {footer}
    </section>
  );
}
