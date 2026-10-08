// The photosensitivity acknowledgement, given for engine-driven frames that
// play the strobe energies: the live engine renders those only with it. Held
// in memory and taken back after; nothing is written to a settings file.
import { settings } from '../../src/server/settings.ts';

/** Acknowledge until the returned function is called. */
export function acknowledgeFlashes() {
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings.save = () => {};
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: true } };
  return () => {
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
  };
}
