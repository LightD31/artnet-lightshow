/**
 * Whether anything leaves the machine.
 *
 * This server runs all day on a home server beside Home Assistant, and the
 * rig it drives is the house's own lamps: a WLED it sends to is held in
 * realtime mode, a Hue bridge it streams to is in entertainment mode, and
 * neither answers the house while that lasts. So the outputs are a switch a
 * party arms — Perform, Settings → Show, or POST /api/outputs/arm — and one
 * that is off whenever the server starts, whatever was stored (apply.ts).
 *
 * The flag lives on its own because everything reads it: the transmitter
 * through the config it is handed with every frame (transmit.ts), the Hue
 * sessions through output.ts, the live state and the health report. Only
 * output.setArmed() writes it, since arming is more than the flag.
 */

let armed = false;

/** Whether frames may leave the machine right now. */
function isArmed(): boolean { return armed; }

/** output.setArmed() is the entry point; this is the flag alone. True when it changed. */
function setArmedFlag(on: boolean): boolean {
  if (armed === on) return false;
  armed = on;
  return true;
}

export { isArmed, setArmedFlag };
