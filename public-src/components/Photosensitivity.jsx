import { useRef, useState } from 'preact/hooks';
import { api, pick } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';


export const isAcknowledged = (safety) => !!(safety && safety.photosensitivityAcknowledged);

export function guardRapid(acknowledged, name, run, ask) {
  if (acknowledged) {
    run();
    return true;
  }
  ask({ name, run });
  return false;
}

export async function acknowledgeThen(run) {
  const res = await api('/api/safety/acknowledge', { method: 'POST' });
  if (!res.ok) return false;
  if (run) run();
  return true;
}

export function Photosensitivity({ name, preset, allow = false, onConfirm, onCancel }) {
  const box = useRef(null);
  useFocusTrap(box, true, onCancel);
  const what = allow ? 'The strobe and every fast-flashing effect' : name || (preset && preset.name) || 'This effect';
  return (
    <div class="confirm-veil" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={box} class="confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="photosensitivity-title"
        aria-describedby="photosensitivity-text" tabIndex={-1}>
        <h2 id="photosensitivity-title">Rapid flashing</h2>
        <p id="photosensitivity-text">
          <strong>{what}</strong> {allow ? 'flash' : 'flashes'} the lamps faster than the show otherwise ever does. Flashing at that rate can
          bring on a seizure in someone with photosensitive epilepsy. Make sure nobody in the room is at risk and that the
          flashing is announced. {allow ? 'Allowing them' : 'Playing it'} acknowledges this for the whole server, once.
        </p>
        <div class="confirm-actions">
          <button type="button" class="btn" onClick={onCancel}>Cancel</button>
          <button type="button" class="btn danger" onClick={onConfirm}>{allow ? 'I understand — allow them' : 'I understand — play it'}</button>
        </div>
      </div>
    </div>
  );
}

// Keep a local acknowledgement while the server response is ahead of its state broadcast.
export function useSafetyGate() {
  const s = pick(['safety']);
  const [question, setQuestion] = useState(null);
  const [given, setGiven] = useState(false);
  const acknowledged = given || isAcknowledged(s.safety);
  const guard = (name, run) => guardRapid(acknowledged, name, run, setQuestion);
  const confirm = async () => {
    const q = question;
    setQuestion(null);
    if (await acknowledgeThen(q.run)) setGiven(true);
  };
  const dialog = question
    ? <Photosensitivity name={question.name} onConfirm={confirm} onCancel={() => setQuestion(null)} />
    : null;
  return { acknowledged, guard, dialog };
}

export function StrobesOff({ perform = false }) {
  const s = pick(['safety']);
  const [asking, setAsking] = useState(false);
  if (!s.safety || isAcknowledged(s.safety)) return null;
  const dialog = asking && (
    <Photosensitivity allow onConfirm={() => { setAsking(false); acknowledgeThen(); }} onCancel={() => setAsking(false)} />
  );
  const title = 'The strobe and every fast-flashing effect are refused until the photosensitivity acknowledgement — tap to give it';
  if (!perform) {
    return (
      <>
        <button type="button" class="stat-pill gate" data-safety="ask" title={title} onClick={() => setAsking(true)}>
          Strobes off until acknowledged
        </button>
        {dialog}
      </>
    );
  }
  return (
    <section class="perform-gate" aria-label="Photosensitivity">
      <button type="button" class="perform-gate-button" data-safety="ask" title={title} onClick={() => setAsking(true)}>
        <span class="perform-gate-state">Strobes off until acknowledged</span>
        <span class="perform-gate-hint">tap to acknowledge</span>
      </button>
      {dialog}
    </section>
  );
}
