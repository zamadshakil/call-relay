import { describe, expect, it } from "vitest";
import { LatestAuthoritativeRecovery } from "./authoritative-recovery";

describe("latest authoritative recovery", () => {
  it("does not resurrect a delayed accepted call after a newer null response", async () => {
    const recovery = new LatestAuthoritativeRecovery<{ id: string; state: string } | undefined>();
    let releaseAccepted: ((value: { id: string; state: string }) => void) | undefined;
    const delayedAccepted = new Promise<{ id: string; state: string }>((resolve) => {
      releaseAccepted = resolve;
    });
    let current: { id: string; state: string } | undefined;

    const older = recovery.run(() => delayedAccepted, (value) => { current = value; });
    const newer = recovery.run(async () => undefined, (value) => { current = value; });

    expect(await newer).toBe(true);
    expect(current).toBeUndefined();
    releaseAccepted?.({ id: "call_old", state: "accepted" });
    expect(await older).toBe(false);
    expect(current).toBeUndefined();
  });
});
