import { describe, expect, it } from "vitest";
import { SignalingGenerationGuard } from "./signaling-generation";

describe("signaling socket generation", () => {
  it("rejects an old queued revocation after a new pairing socket is bound", () => {
    const guard = new SignalingGenerationGuard<object>();
    const oldSocket = {};
    const oldGeneration = guard.begin("pair_old");
    expect(guard.bind(oldGeneration, "pair_old", oldSocket)).toBe(true);

    // The old onmessage callback has been queued but has not executed yet.
    const newSocket = {};
    const newGeneration = guard.begin("pair_new");
    expect(guard.bind(newGeneration, "pair_new", newSocket)).toBe(true);

    expect(guard.isCurrent(oldGeneration, "pair_old", oldSocket)).toBe(false);
    expect(guard.isCurrent(newGeneration, "pair_new", newSocket)).toBe(true);
  });
});
