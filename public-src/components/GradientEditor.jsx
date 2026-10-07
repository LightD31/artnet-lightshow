export const gradientSettings = (p) => ({ gradients: p.gradients ?? [], sets: p.sets ?? [],
  gradient: p.gradient ?? null, gradientSet: p.gradientSet ?? null, gradientRole: p.gradientRole ?? 0 });

export function GradientEditor({ body, onChange }) {
  const gradients = body.gradients || [], sets = body.sets || [];
  const edit = (patch) => onChange({ ...body, ...patch });
  const change = (i, patch) => edit({ gradients: gradients.map((g, j) => j === i ? { ...g, ...patch } : g) });
  const rename = (i, name) => {
    const old = gradients[i].name;
    edit({ gradients: gradients.map((g, j) => j === i ? { ...g, name } : g),
      sets: sets.map((s) => ({ ...s, roles: s.roles.map((r) => r === old ? name : r) })),
      gradient: body.gradient === old ? name : body.gradient });
  };
  const remove = (i) => {
    const name = gradients[i].name;
    const remaining = sets.map((s) => ({ ...s, roles: s.roles.filter((r) => r !== name) })).filter((s) => s.roles.length);
    edit({ gradients: gradients.filter((_, j) => j !== i), sets: remaining,
      gradient: body.gradient === name ? null : body.gradient,
      gradientSet: remaining.some((s) => s.name === body.gradientSet) ? body.gradientSet : null });
  };
  const unique = (list, stem) => {
    let n = 1;
    while (list.some((g) => g.name === `${stem} ${n}`)) n++;
    return `${stem} ${n}`;
  };
  return <details class="palette-gradients">
    <summary>Gradients and sets</summary>
    <p class="muted">Stops can follow a palette slot, including Random, or hold a fixed RGBWAUV colour. Sets name up to four gradient roles.</p>
    {gradients.map((g, i) => <fieldset key={i}>
      <legend>Gradient {i + 1}</legend>
      <label>Name <input aria-label={`Gradient ${i + 1} name`} value={g.name} maxLength={40} onInput={(e) => rename(i, e.target.value)} /></label>
      <label>Colour space <select value={g.space} onChange={(e) => change(i, { space: e.target.value })}>
        <option value="rgb">Linear RGBWAUV</option><option value="oklch">OkLCh</option><option value="step">Steps</option>
      </select></label>
      <label><input type="checkbox" checked={g.wrap} onChange={(e) => change(i, { wrap: e.target.checked })} />Wrap</label>
      {g.stops.map((s, k) => {
        const stop = (next) => change(i, { stops: g.stops.map((v, j) => j === k ? next : v) });
        return <div class="gradient-stop" key={k}>
          <label>Position <input type="number" min="0" max="1" step="0.01" value={s.at}
            aria-label={`Gradient ${i + 1} stop ${k + 1} position`} onInput={(e) => stop({ ...s, at: Number(e.target.value) })} /></label>
          <label>Colour <select value={'slot' in s ? String(s.slot) : 'fixed'} onChange={(e) => stop(e.target.value === 'fixed'
            ? { at: s.at, colour: '#FFFFFF' } : { at: s.at, slot: Number(e.target.value) })}>
            {body.colours.map((_, n) => <option key={n} value={n}>Slot {n + 1}</option>)}<option value="fixed">Fixed colour</option>
          </select></label>
          {'colour' in s && <input aria-label={`Gradient ${i + 1} stop ${k + 1} colour`} value={s.colour} maxLength={13}
            onInput={(e) => stop({ ...s, colour: e.target.value })} />}
          <button type="button" class="btn sm" disabled={g.stops.length <= 2} aria-label={`Remove gradient ${i + 1} stop ${k + 1}`}
            onClick={() => change(i, { stops: g.stops.filter((_, j) => j !== k) })}>×</button>
        </div>;
      })}
      <button type="button" class="btn sm" disabled={g.stops.length >= 16} onClick={() => {
        let at = 0.5;
        while (g.stops.some((s) => s.at === at)) at /= 2;
        change(i, { stops: [...g.stops, { at, slot: 0 }].sort((a, b) => a.at - b.at) });
      }}>Add stop</button>
      <button type="button" class="btn sm" onClick={() => remove(i)}>Remove gradient</button>
    </fieldset>)}
    <button type="button" class="btn sm" disabled={gradients.length >= 8} onClick={() => edit({ gradients: [...gradients,
      { name: unique(gradients, 'Gradient'), space: 'oklch', wrap: true, stops: [{ at: 0, slot: 0 }, { at: 0.5, slot: body.colours.length - 1 }] }] })}>Add gradient</button>
    {!!gradients.length && <>
      <label>Active gradient <select aria-label="Active gradient" value={body.gradient || ''} onChange={(e) => edit({ gradient: e.target.value || null, gradientSet: null })}>
        <option value="">First gradient</option>{gradients.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
      </select></label>
      {sets.map((s, i) => {
        const set = (next) => edit({ sets: sets.map((v, j) => j === i ? next : v), gradientSet: body.gradientSet === s.name ? next.name : body.gradientSet });
        return <fieldset key={i}><legend>Gradient set {i + 1}</legend>
          <label>Name <input value={s.name} maxLength={40} onInput={(e) => set({ ...s, name: e.target.value })} /></label>
          {[0, 1, 2, 3].map((k) => <label key={k}>Role {k + 1} <select value={s.roles[k] || ''} onChange={(e) => {
            const roles = [...s.roles]; roles[k] = e.target.value; set({ ...s, roles: roles.filter(Boolean) });
          }}><option value="">Unused</option>{gradients.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</select></label>)}
          <button type="button" class="btn sm" onClick={() => edit({ sets: sets.filter((_, j) => j !== i), gradientSet: body.gradientSet === s.name ? null : body.gradientSet })}>Remove set</button>
        </fieldset>;
      })}
      <button type="button" class="btn sm" disabled={sets.length >= 8} onClick={() => edit({ sets: [...sets, { name: unique(sets, 'Set'), roles: [gradients[0].name] }] })}>Add gradient set</button>
      {!!sets.length && <>
        <label>Active set <select aria-label="Active set" value={body.gradientSet || ''} onChange={(e) => edit({ gradientSet: e.target.value || null })}>
          <option value="">None</option>{sets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select></label>
        <label>Active role <select aria-label="Active role" value={body.gradientRole || 0} onChange={(e) => edit({ gradientRole: Number(e.target.value) })}>
          {[0, 1, 2, 3].map((n) => <option key={n} value={n}>Role {n + 1}</option>)}
        </select></label>
      </>}
    </>}
  </details>;
}
