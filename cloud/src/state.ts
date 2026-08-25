import type { CallState } from "./types";

const transitions: Record<CallState, ReadonlySet<CallState>> = {
  created: new Set(["ringing_peer", "dialing_sim", "ended", "failed"]),
  ringing_peer: new Set(["accepted", "ending", "ended", "failed"]),
  accepted: new Set(["dialing_sim", "active", "ending", "ended", "failed"]),
  dialing_sim: new Set(["active", "ending", "ended", "failed"]),
  active: new Set(["ending", "ended", "failed"]),
  ending: new Set(["ended", "failed"]),
  ended: new Set(),
  failed: new Set(),
};

export function canTransition(from: CallState, to: CallState): boolean {
  return from === to || transitions[from].has(to);
}

export function isE164(number: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(number);
}
