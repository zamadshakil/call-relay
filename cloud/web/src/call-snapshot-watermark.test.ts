import { describe, expect, it } from "vitest";
import { CallSnapshotWatermarks } from "./call-snapshot-watermark";

describe("call snapshot watermarks", () => {
  it("rejects delayed accepted and active snapshots after a terminal snapshot", () => {
    const watermarks = new CallSnapshotWatermarks();
    const accepted = { id: "call_1", state: "accepted", version: 4 };
    const ended = { id: "call_1", state: "ended", version: 5 };

    expect(watermarks.classify(accepted)).toBe("newer");
    watermarks.commit(accepted);
    expect(watermarks.classify(ended)).toBe("newer");
    watermarks.commit(ended);

    expect(watermarks.classify(accepted)).toBe("stale");
    expect(watermarks.classify({ ...accepted, state: "active", version: 5 })).toBe("stale");
    expect(watermarks.classify({ id: "call_2", state: "ringing_peer", version: 0 })).toBe("newer");
  });

  it("tombstones a known call when current-call recovery returns no call", () => {
    const watermarks = new CallSnapshotWatermarks();
    const active = { id: "call_1", state: "active", version: 7 };
    watermarks.commit(active);
    watermarks.close(active);

    expect(watermarks.classify(active)).toBe("stale");
    expect(watermarks.classify({ ...active, version: 8 })).toBe("stale");
  });
});
