import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { pick, send, connectedSig, toast, api, emitFixture } from '../../state.js';
import { settingsSig, loadSettings, saveSettings, networkInterfaces, post, at } from '../../setup-state.js';
import { useFocusTrap } from '../../focus-trap.js';
import { identifyFixtures } from '../../rig-ui.js';
import { AddFixtures } from './PatchTable.jsx';
import { PlanEditor, rowPositions } from './PlanEditor.jsx';
import { runPreflight, preflightSig, PreflightReport } from './PreflightView.jsx';
import { stagePositions } from '../../../src/shared/stage.ts';
import { patchedAt } from '../../utils.js';

/**
 * The first-run setup: from a fresh install to a rig that answers, in the
 * order it has to happen — where the DMX goes, what is hung, where it hangs,
 * what the lights follow — and then the pre-show check to prove it.
 *
 * Offered once, on a fresh install (settings.setup.completed), and from
 * Settings whenever it is wanted again. Each step writes through the same
 * routes the Rig, Sources and Settings views use, and changes nothing it does
 * not ask about; leaving part way keeps what was done.
 */

export const wizardSig = signal({ open: false, step: 0 });
export function openWizard() { wizardSig.value = { open: true, step: 0 }; }

const STEPS = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'outputs', title: 'Outputs' },
  { id: 'fixtures', title: 'Fixtures' },
  { id: 'place', title: 'Placement' },
  { id: 'music', title: 'Music' },
  { id: 'check', title: 'Check' },
];

/** Offer the setup when the server says it has never been done. */
export function useFirstRun() {
  useEffect(() => {
    let cancelled = false;
    const check = (data) => {
      if (!cancelled && data && data.settings && data.settings.setup && data.settings.setup.completed === false && !wizardSig.value.open) {
        wizardSig.value = { open: true, step: 0 };
      }
    };
    if (settingsSig.value) check(settingsSig.value);
    else loadSettings().then(check);
    return () => { cancelled = true; };
  }, []);
}

async function finish() {
  wizardSig.value = { open: false, step: 0 };
  await saveSettings({ setup: { completed: true } });
}

// ── Steps ────────────────────────────────────────────────────────────────────

function Welcome() {
  return (
    <div class="wizard-body">
      <p class="wizard-lead">Five short steps from here to a rig that follows the music.</p>
      <ol class="wizard-list">
        <li><strong>Outputs</strong> — where the DMX goes: Art-Net nodes, sACN, WLEDs.</li>
        <li><strong>Fixtures</strong> — what is hung, patched from its profile and address.</li>
        <li><strong>Placement</strong> — where each one hangs, so chases travel the right way.</li>
        <li><strong>Music</strong> — what the show follows: CDJs, this computer's player, the room.</li>
        <li><strong>Check</strong> — the pre-show check, to prove it.</li>
      </ol>
      <p class="setting-help">Nothing changes that a step does not ask about, and every step can be done again later from
        the Rig, Sources and Settings views.</p>
    </div>
  );
}

/** Where the DMX goes: Art-Net to a broadcast or one node, sACN, and any WLEDs. */
function Outputs({ register }) {
  const s = pick(['artnet']);
  const data = settingsSig.value;
  const ifaces = networkInterfaces.use();
  const [artnet, setArtnet] = useState(s.artnet ? s.artnet.enabled !== false : true);
  const [host, setHost] = useState((s.artnet && s.artnet.host) || '2.255.255.255');
  const [sacn, setSacn] = useState(!!at(data && data.settings, 'sacn.enabled'));
  const [nodes, setNodes] = useState(null);
  const [wleds, setWleds] = useState(null);
  const [status, setStatus] = useState('');

  register(async () => {
    send({ artnet: { enabled: artnet, host } });
    const res = await saveSettings({ sacn: { enabled: sacn } });
    return res.ok;
  });

  const findNodes = async () => {
    setStatus('Asking the network for Art-Net nodes…');
    try {
      const res = await (await fetch('/api/artnet/nodes?scan=1')).json();
      setNodes(res.nodes || []);
      setStatus(res.nodes && res.nodes.length ? '' : 'No node answered. Many never reply to polls: a broadcast still reaches them.');
    } catch {
      setStatus('Could not ask the network');
    }
  };
  const findWleds = async () => {
    setStatus('Asking the network for WLEDs…');
    try {
      const res = await (await fetch('/api/wled/discover')).json();
      setWleds(res.devices || []);
      setStatus(res.devices && res.devices.length ? '' : 'No WLED answered.');
    } catch {
      setStatus('Could not ask the network');
    }
  };
  const addWled = async (address) => {
    const res = await post('/api/wled/add', { host: address });
    if (res.ok) setWleds((list) => list.map((d) => (d.host === address ? { ...d, patched: res.fixture.label } : d)));
  };
  const broadcasts = [...new Set(['2.255.255.255', ...ifaces.map((i) => i.broadcast).filter(Boolean)])];

  return (
    <div class="wizard-body">
      <p class="wizard-lead">Where should the lights' data go?</p>
      <fieldset class="wizard-group">
        <legend>Art-Net</legend>
        <label class="wizard-check"><input type="checkbox" checked={artnet} onChange={(e) => setArtnet(e.target.checked)} /> Send Art-Net</label>
        {artnet && <>
          <label class="wizard-field"><span>Send to</span>
            <input type="text" value={host} onInput={(e) => setHost(e.target.value)} list="wizard-broadcasts" aria-describedby="wizard-host-help" />
          </label>
          <datalist id="wizard-broadcasts">{broadcasts.map((b) => <option key={b} value={b} />)}</datalist>
          <p class="setting-help" id="wizard-host-help">A broadcast address ({broadcasts.join(', ')}) reaches every node on that network;
            a node's own address sends to it alone. The server finds the nodes behind a broadcast and sends each its own universes.</p>
          <div class="discovery-head">
            <button type="button" class="btn sm" onClick={findNodes}>Find nodes</button>
          </div>
          {nodes && nodes.length > 0 && (
            <ul class="wizard-found">
              {nodes.map((n) => (
                <li key={n.address}>
                  <span><strong>{n.shortName || n.longName || 'Node'}</strong> {n.address}{n.outputs && n.outputs.length ? ` · universes ${n.outputs.join(', ')}` : ''}</span>
                  <button type="button" class="btn sm" onClick={() => post('/api/artnet/identify', { address: n.address, universes: n.outputs || [] })}>Identify</button>
                  <button type="button" class="btn sm" onClick={() => setHost(n.address)}>Send only here</button>
                </li>
              ))}
            </ul>
          )}
        </>}
      </fieldset>
      <fieldset class="wizard-group">
        <legend>sACN</legend>
        <label class="wizard-check"><input type="checkbox" checked={sacn} onChange={(e) => setSacn(e.target.checked)} /> Send sACN (E1.31) too</label>
        <p class="setting-help">What consoles and most modern nodes speak, multicast to each universe's own group. Its details are under
          Rig → Outputs.</p>
      </fieldset>
      <fieldset class="wizard-group">
        <legend>WLED</legend>
        <p class="setting-help">WLED strips and panels are sent their pixels directly, over DDP. Found ones can be added to the patch now, in
          eight zones like an LED bar; add one as a wash or pixel by pixel under Rig → Outputs → WLED.</p>
        <div class="discovery-head"><button type="button" class="btn sm" onClick={findWleds}>Find WLEDs</button></div>
        {wleds && wleds.length > 0 && (
          <ul class="wizard-found">
            {wleds.map((d) => (
              <li key={d.host}>
                <span><strong>{d.name}</strong> {d.host}{d.leds ? ` · ${d.leds} LEDs` : ''}</span>
                {!d.error && <button type="button" class="btn sm" onClick={() => post('/api/wled/identify', { host: d.host })}>Identify</button>}
                {d.patched ? <span class="setting-help">In the patch</span>
                  : !d.error && <button type="button" class="btn sm active" onClick={() => addWled(d.host)}>Add</button>}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {!artnet && !sacn && (
        <p class="setting-help setting-note warn">Neither Art-Net nor sACN is on: only WLEDs and Hue lamps will get the show.</p>
      )}
      {status && <p class="setting-help" role="status">{status}</p>}
    </div>
  );
}

/** What is hung: the patch as it stands, and adding to it. */
function Fixtures() {
  const s = pick(['fixtures', 'profiles', 'identify']);
  const fixtures = s.fixtures || [];
  const profiles = s.profiles || {};
  const remove = async (fix) => { await api(`/api/fixtures/${fix.id}`, { method: 'DELETE' }); };
  return (
    <div class="wizard-body">
      <p class="wizard-lead">What is hung? Add each kind of fixture with how many there are and where the first one is
        addressed; the rest follow on.</p>
      <p class="setting-help">A fixture missing from the list of profiles can be imported (GDTF or Open Fixture Library) or made
        from its manual under Rig → Profiles, and added there.</p>
      <AddFixtures />
      <h3 class="wizard-sub">In the patch ({fixtures.length})</h3>
      <ul class="wizard-patch">
        {fixtures.map((f, i) => {
          const p = profiles[f.profileId];
          return (
            <li key={f.id}>
              <span class="mono">{i + 1}</span>
              <span class="wizard-patch-label">{f.label}</span>
              <span class="setting-help">{p ? p.name : f.profileId} · {patchedAt(f)}</span>
              <button type="button" class="btn sm" disabled={!connectedSig.value} onClick={() => identifyFixtures([f.id])}>Identify</button>
              <button type="button" class="remove-btn" aria-label={`Remove ${f.label}`} disabled={fixtures.length <= 1} onClick={() => remove(f)}>×</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Place() {
  const s = pick(['fixtures']);
  const fixtures = s.fixtures || [];
  // A quick start: every fixture along one row, in patch order, to drag from.
  const inRow = () => {
    const points = stagePositions(fixtures).map((p, k) => ({ x: fixtures.length > 1 ? 10 + (80 * k) / (fixtures.length - 1) : 50, y: p.y }));
    rowPositions(points).forEach((position, k) => emitFixture({ id: fixtures[k].id, position }));
  };
  return (
    <div class="wizard-body">
      <p class="wizard-lead">Where does each one hang? Drag them to their places on the plan: the audience is at the bottom.</p>
      <p class="setting-help">Patterns travel across the rig as it is placed here. For an LED bar, select it and press Draw bar:
        it lights up on the rig with its first cell green, and you drag from its green end to its red end.</p>
      <div class="setting-actions">
        <button type="button" class="btn sm" disabled={!fixtures.length || !connectedSig.value} onClick={inRow}>Put them all in a row, in patch order</button>
      </div>
      <PlanEditor />
    </div>
  );
}

/** What the show follows. */
function Music({ register }) {
  const data = settingsSig.value;
  const read = (path) => at(data && data.settings, path);
  const [prolink, setProlink] = useState(!!read('sources.prolink'));
  const [smtc, setSmtc] = useState(read('sources.smtc') !== false);
  const [live, setLive] = useState(!!read('live.enabled'));
  const [source, setSource] = useState(read('live.source') || 'loopback');
  const [clientId, setClientId] = useState(read('spotify.clientId') || '');
  const [secret, setSecret] = useState('');
  const secretSet = !!(data && data.secrets && data.secrets['spotify.clientSecret']);
  register(async () => {
    const patch = {
      sources: { prolink, smtc },
      live: { enabled: live, source },
      spotify: { clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}) },
    };
    const res = await saveSettings(patch);
    return res.ok;
  });
  return (
    <div class="wizard-body">
      <p class="wizard-lead">What should the lights follow? Any number of these; the show takes whichever is playing.</p>
      <fieldset class="wizard-group">
        <legend>Players</legend>
        <label class="wizard-check"><input type="checkbox" checked={prolink} onChange={(e) => setProlink(e.target.checked)} /> Pioneer CDJs (PRO DJ LINK)</label>
        <label class="wizard-check"><input type="checkbox" checked={smtc} onChange={(e) => setSmtc(e.target.checked)} /> Whatever plays on this computer (its media session, on Windows or Linux)</label>
      </fieldset>
      <fieldset class="wizard-group">
        <legend>Listening</legend>
        <label class="wizard-check"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Hear the music live, to keep the beat of any track</label>
        {live && (
          <label class="wizard-field"><span>Listen to</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="loopback">What this computer plays</option>
              <option value="input">An input (line-in or microphone)</option>
            </select>
          </label>
        )}
      </fieldset>
      <fieldset class="wizard-group">
        <legend>Spotify</legend>
        <p class="setting-help">For a show planned ahead from the track itself. The client ID and secret come from your app in
          Spotify's developer dashboard; connect afterwards under Sources.</p>
        <label class="wizard-field"><span>Client ID</span><input type="text" value={clientId} onInput={(e) => setClientId(e.target.value)} /></label>
        <label class="wizard-field"><span>Client secret</span>
          <input type="password" autocomplete="new-password" value={secret} placeholder={secretSet ? '•••••••• (leave blank to keep)' : 'not set'}
            onInput={(e) => setSecret(e.target.value)} /></label>
      </fieldset>
    </div>
  );
}

function Check() {
  const { running, report, error } = preflightSig.value;
  useEffect(() => { if (!report && !running) runPreflight(); }, []);
  return (
    <div class="wizard-body">
      <p class="wizard-lead">The pre-show check: every output, source and tool the show needs, asked directly.</p>
      <div class="setting-actions">
        <button type="button" class="btn" disabled={running} onClick={runPreflight}>{running ? 'Checking…' : 'Check again'}</button>
      </div>
      {error && <p class="import-status error" role="alert">{error}</p>}
      {report && <PreflightReport report={report} />}
    </div>
  );
}

// ── The dialog ───────────────────────────────────────────────────────────────

export function Wizard() {
  const { open, step } = wizardSig.value;
  const box = useRef(null);
  const leave = useRef(null);   // the step's "apply before moving on", if it has one
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useFocusTrap(box, open, () => setConfirming(true));
  useEffect(() => { if (!open) setConfirming(false); }, [open]);
  if (!open) return null;

  leave.current = null;
  const register = (fn) => { leave.current = fn; };
  const current = STEPS[step];
  const go = async (to) => {
    if (to > step && leave.current) {
      setBusy(true);
      const ok = await leave.current();
      setBusy(false);
      if (ok === false) return;
    }
    wizardSig.value = { open: true, step: Math.max(0, Math.min(STEPS.length - 1, to)) };
  };
  const done = async () => {
    if (leave.current && (await leave.current()) === false) return;
    await finish();
    toast.info('Setup done. The Rig, Sources and Settings views hold everything it touched.');
  };

  return (
    <div class="wizard-backdrop">
      <div ref={box} class="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" tabIndex={-1}>
        <div class="wizard-head">
          <h2 id="wizard-title">Set up the rig <span class="wizard-step-name">— {current.title}</span></h2>
          <button type="button" class="btn sm" onClick={() => setConfirming(true)}>Skip setup</button>
        </div>
        <ol class="wizard-steps" aria-label="Steps">
          {STEPS.map((st, i) => (
            <li key={st.id} class={`${i === step ? 'current' : ''} ${i < step ? 'done' : ''}`} aria-current={i === step ? 'step' : undefined}>
              <button type="button" class="wizard-step-btn" onClick={() => go(i)} disabled={busy}>{i > 0 ? `${i}. ` : ''}{st.title}</button>
            </li>
          ))}
        </ol>
        {confirming ? (
          <div class="wizard-body" role="alertdialog" aria-labelledby="wizard-leave">
            <p class="wizard-lead" id="wizard-leave">Leave the setup? What has been done so far is kept, and it can be run again from
              Settings at any time.</p>
            <div class="setting-actions">
              <button type="button" class="btn active" onClick={finish}>Leave the setup</button>
              <button type="button" class="btn" onClick={() => setConfirming(false)}>Keep going</button>
            </div>
          </div>
        ) : (
          <>
            {current.id === 'welcome' && <Welcome />}
            {current.id === 'outputs' && <Outputs register={register} />}
            {current.id === 'fixtures' && <Fixtures />}
            {current.id === 'place' && <Place />}
            {current.id === 'music' && <Music register={register} />}
            {current.id === 'check' && <Check />}
            <div class="wizard-foot">
              {step > 0 && <button type="button" class="btn" disabled={busy} onClick={() => go(step - 1)}>Back</button>}
              <span class="wizard-foot-gap" />
              {step < STEPS.length - 1
                ? <button type="button" class="btn active" disabled={busy} onClick={() => go(step + 1)}>{step === 0 ? 'Start' : 'Next'}</button>
                : <button type="button" class="btn active" onClick={done}>Finish</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
