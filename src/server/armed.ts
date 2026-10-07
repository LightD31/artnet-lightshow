// Only output.setArmed() writes this flag because arming also changes output sessions.

let armed = false;

function isArmed(): boolean { return armed; }

function setArmedFlag(on: boolean): boolean {
  if (armed === on) return false;
  armed = on;
  return true;
}

export { isArmed, setArmedFlag };
