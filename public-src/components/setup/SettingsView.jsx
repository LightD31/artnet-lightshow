import { useEffect, useState } from 'preact/hooks';
import { pick, socket, emitLive } from '../../state.js';
import { useSettings, settingsSig, saveSettings, at } from '../../setup-state.js';
import { SettingsSection } from './Section.jsx';
import { SHOW, ENGINE, MIDI_CLOCK, SERVER } from './specs.js';
import { MidiMap } from './MidiMap.jsx';
import { openWizard } from './Wizard.jsx';
import { RestartBanner } from './RestartBanner.jsx';

/**
 * Everything else: how the show behaves over a night, the MIDI controller
 * and what its controls do, the engine, and the server itself.
 */

/** The control surface: its ports, whether it is connected, motorised feedback. */
function MidiController() {
  const s = pick(['midi']);
  const data = settingsSig.value;
  const midi = s.midi || { enabled: false, ports: { inputs: [], outputs: [] } };
  const ports = midi.ports || { inputs: [], outputs: [] };
  const [input, setInput] = useState(null);
  const [output, setOutput] = useState(null);
  const [status, setStatus] = useState(null);
  const inputShown = input ?? (at(data && data.settings, 'midi.input') || '');
  const outputShown = output ?? (at(data && data.settings, 'midi.output') || '');
  const feedback = at(data && data.settings, 'midi.controlFeedback') !== false;

  useEffect(() => {
    const onStatus = ({ ok, enabled }) => setStatus(enabled || ok ? 'Connected' : 'Could not connect to those ports');
    socket.on('midi-status', onStatus);
    return () => socket.off('midi-status', onStatus);
  }, []);

  const connect = () => {
    setStatus('Connecting…');
    emitLive('midi-connect', { input: inputShown || null, output: outputShown || null });
  };
  const select = (id, label, value, set, list) => (
    <div class="setting-field">
      <label for={id}>{label}</label>
      <div class="setting-control">
        <select id={id} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">— auto-detect —</option>
          {value && !list.includes(value) && <option value={value}>{value} (not connected)</option>}
          {list.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
    </div>
  );
  return (
    <section class="panel setup-section" aria-labelledby="midi-title">
      <header class="panel-head">
        <h2 class="panel-title" id="midi-title">MIDI controller</h2>
        <span class={`panel-tag ${midi.enabled ? 'ok' : ''}`}>{midi.enabled ? 'Connected' : 'Not connected'}</span>
      </header>
      <p class="section-desc">A control surface — a Behringer X-Touch Compact by default — driving the look, and its faders and
        encoder rings following the show.</p>
      <div class="setting-rows">
        {select('midi-input', 'Input port', inputShown, setInput, ports.inputs || [])}
        {select('midi-output', 'Output port', outputShown, setOutput, ports.outputs || [])}
        <div class="setting-field">
          <label for="midi-feedback">Motorised feedback</label>
          <div class="setting-control">
            <input id="midi-feedback" type="checkbox" checked={feedback} aria-describedby="midi-feedback-help"
              onChange={(e) => saveSettings({ midi: { controlFeedback: e.target.checked } })} />
          </div>
        </div>
        <p class="setting-help" id="midi-feedback-help">Drive motorised faders and encoder rings to match the show. Turn off only
          if a MIDI loopback echoes it back as input. Takes effect at once, without dropping the port.</p>
      </div>
      <div class="setting-actions">
        <button type="button" class="btn active" onClick={connect}>Connect</button>
        {status && <span class="import-status" role="status">{status}</span>}
      </div>
    </section>
  );
}

function SetupAgain() {
  const data = settingsSig.value;
  const done = at(data && data.settings, 'setup.completed');
  return (
    <section class="panel setup-section" aria-labelledby="setup-again-title">
      <header class="panel-head"><h2 class="panel-title" id="setup-again-title">Setup</h2></header>
      <p class="section-desc">The first-run setup walks through the outputs, the fixtures, where they hang and the music, and
        ends with the pre-show check. It changes nothing it does not ask about.{done === false ? ' It has not been finished yet.' : ''}</p>
      <div class="setting-actions">
        <button type="button" class="btn" onClick={openWizard}>Run the setup again</button>
      </div>
    </section>
  );
}

export function SettingsView() {
  useSettings();
  const s = pick(['midi']);
  const outputs = (s.midi && s.midi.ports && s.midi.ports.outputs) || [];
  const data = settingsSig.value;
  return (
    <div class="setup-view">
      <RestartBanner />
      <div class="setup-columns">
        <div class="setup-col">
          <SettingsSection {...SHOW} />
          <MidiController />
          <MidiMap />
        </div>
        <div class="setup-col">
          <SettingsSection {...MIDI_CLOCK} ctx={{ midiOutputs: outputs }} />
          <SettingsSection {...ENGINE} />
          <SettingsSection {...SERVER}
            footer={data && data.configFile ? <p class="setting-help">Stored in {data.configFile}.</p> : null} />
          <SetupAgain />
        </div>
      </div>
    </div>
  );
}
