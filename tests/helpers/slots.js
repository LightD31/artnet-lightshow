/** A rendered slot as the tests read it: its colour, a 0..255 dimmer and the strobe channel (0 when the kind writes none). */
export const slotToWrite = (slot) => ({ colour: slot.colour, dim: Math.round(255 * slot.level), strobe: slot.strobe ?? 0 });
