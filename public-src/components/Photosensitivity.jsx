import { useRef, useState } from 'preact/hooks';
import { api, pick } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';

/**
 * The photosensitivity warning, as both apps show it once. It is asked while
 * the server has no acknowledgement; Yes saves one there (POST
 * /api/safety/acknowledge) and then plays, and from then on nothing asks.
 * The Effects view, the strobe pad and a rapid matrix mode all ask through it.
 */

export const isAcknowledged = (safety) => !!(safety && safety.photosensitivityAcknowledged);

/** Runs `run` when acknowledged; otherwise hands `ask` the question and runs nothing. */
export function guardRapid(acknowledged, name, run, ask) {
  if (acknowledged) {
    run();
    return true;
  }
  ask({ name, run });
  return false;
}

/** Saves the acknowledgement, then runs `run`; a refusal runs nothing. */
export async function acknowledgeThen(run) {
  const res = await api('/api/safety/acknowledge', { method: 'POST' });
  if (!res.ok) return false;
  if (run) run();
  return true;
}

export function Photosensitivity({ name, preset, onConfirm, onCancel }) {
  const box = useRef(null);
  useFocusTrap(box, true, onCancel);
  const what = name || (preset && preset.name) || 'This effect';
  return (
    <div class="confirm-veil" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={box} class="confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="photosensitivity-title"
        aria-describedby="photosensitivity-text" tabIndex={-1}>
        <h2 id="photosensitivity-title">Rapid flashing</h2>
        <p id="photosensitivity-text">
          <strong>{what}</strong> flashes the lamps faster than the show otherwise ever does. Flashing at that rate can
          bring on a seizure in someone with photosensitive epilepsy. Make sure nobody in the room is at risk and that the
          flashing is announced. Playing it acknowledges this for the whole server, once.
        </p>
        <div class="confirm-actions">
          <button type="button" class="btn" onClick={onCancel}>Cancel</button>
          <button type="button" class="btn danger" onClick={onConfirm}>I understand — play it</button>
        </div>
      </div>
    </div>
  );
}

/**
 * The gate as a hook: `guard(name, run)` plays at once or asks, and `dialog`
 * is the warning to render while a question is open. A local flag covers the
 * moment between the server's answer and the broadcast that carries it.
 */
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
