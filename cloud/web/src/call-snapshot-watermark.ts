export interface VersionedCallSnapshot {
  id: string;
  state: string;
  version: number;
}

export type SnapshotDecision = "newer" | "equal" | "stale";

interface SnapshotWatermark {
  version: number;
  terminal: boolean;
}

const TERMINAL_STATES = new Set(["ended", "failed"]);

/**
 * Keeps a small in-memory tombstone after a call leaves the UI. This prevents
 * an older REST response that was already in flight from resurrecting a call
 * after a terminal WebSocket snapshot (and starting media again).
 */
export class CallSnapshotWatermarks {
  private readonly watermarks = new Map<string, SnapshotWatermark>();

  constructor(private readonly maximumEntries = 64) {}

  classify(snapshot: VersionedCallSnapshot): SnapshotDecision {
    const watermark = this.watermarks.get(snapshot.id);
    if (!watermark) return "newer";
    if (watermark.terminal || snapshot.version < watermark.version) return "stale";
    return snapshot.version === watermark.version ? "equal" : "newer";
  }

  commit(snapshot: VersionedCallSnapshot): void {
    const existing = this.watermarks.get(snapshot.id);
    if (existing?.terminal || (existing && existing.version > snapshot.version)) return;
    this.store(snapshot.id, {
      version: snapshot.version,
      terminal: TERMINAL_STATES.has(snapshot.state),
    });
  }

  close(snapshot: VersionedCallSnapshot): void {
    const existing = this.watermarks.get(snapshot.id);
    this.store(snapshot.id, {
      version: Math.max(existing?.version ?? 0, snapshot.version),
      terminal: true,
    });
  }

  private store(callId: string, watermark: SnapshotWatermark): void {
    // Refresh insertion order so pruning retains the most recently observed
    // calls, including terminal calls with a delayed response still in flight.
    this.watermarks.delete(callId);
    this.watermarks.set(callId, watermark);
    while (this.watermarks.size > this.maximumEntries) {
      const oldest = this.watermarks.keys().next().value as string | undefined;
      if (!oldest) break;
      this.watermarks.delete(oldest);
    }
  }
}
