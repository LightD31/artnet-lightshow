import { validate, midiConnectSchema } from './validation.js';
import { settings } from './settings.ts';

/**
 * Open the named MIDI ports and remember them for the next start.
 *
 * The settings page connects over REST and the main UI over the socket. The
 * two used to be separate implementations, and had already drifted once — one
 * validated its input and the other did not — so both now come here.
 *
 * Throws on an invalid payload; a port that will not open is `ok: false`.
 */
function connectMidi(midi, payload) {
  const { input, output } = validate(midiConnectSchema, payload || {}, 'midi-connect');
  midi.close();
  const ok = midi.connect(input || null, output || null);
  try {
    settings.update({ midi: { input: input || '', output: output || '' } });
  } catch (err) {
    console.warn(`[settings] could not persist MIDI ports: ${err.message}`);
  }
  return { ok, enabled: midi.enabled, ports: midi.listPorts() };
}

export {
  connectMidi,
};
