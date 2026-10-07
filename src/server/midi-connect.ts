import { validate, midiConnectSchema } from './validation.ts';
import { settings } from './settings.ts';
import { messageOf } from '../errors.ts';

export interface MidiPorts {
  enabled: boolean;
  close(): void;
  connect(input: string | null, output: string | null): boolean;
  listPorts(): unknown;
}

function connectMidi(midi: MidiPorts, payload: unknown): { ok: boolean; enabled: boolean; ports: unknown } {
  const { input, output } = validate(midiConnectSchema, payload || {}, 'midi-connect');
  midi.close();
  const ok = midi.connect(input || null, output || null);
  try {
    settings.update({ midi: { input: input || '', output: output || '' } });
  } catch (err) {
    console.warn(`[settings] could not persist MIDI ports: ${messageOf(err)}`);
  }
  return { ok, enabled: midi.enabled, ports: midi.listPorts() };
}

export {
  connectMidi,
};
