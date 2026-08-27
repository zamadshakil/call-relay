import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidPresenceState, IncomingCallRecovery, KeyedSingleFlight, type IncomingPhaseUpdate } from "./incoming-call-controller";

describe("incoming call recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("shares local media initialization between Accept and a concurrent offer", async () => {
    const flight = new KeyedSingleFlight<string>();
    let builds = 0;
    let release: ((value: string) => void) | undefined;
    const build = () => flight.run("call_1", () => {
      builds += 1;
      return new Promise<string>((resolve) => { release = resolve; });
    });

    const acceptSetup = build();
    const offerSetup = build();
    expect(builds).toBe(1);
    release?.("ready");
    await expect(Promise.all([acceptSetup, offerSetup])).resolves.toEqual(["ready", "ready"]);
  });

  it("retries a missed offer when Android comes online", async () => {
    vi.useFakeTimers();
    const requests: Array<{ attempt: number; trigger: string }> = [];
    const recovery = new IncomingCallRecovery({
      requestOffer: async (_callId, _negotiationId, attempt, trigger) => { requests.push({ attempt, trigger }); },
      onPhase: () => undefined,
      onDeadline: () => undefined,
    });
    recovery.begin("call_1", true);
    recovery.setAndroidPresence(false);
    recovery.markLocalReady("call_1");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(requests).toHaveLength(0);

    recovery.setAndroidPresence(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toEqual([{ attempt: 1, trigger: "android_online" }]);
  });

  it("reconciles an equal-version accepted snapshot and requests a replacement offer", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const recovery = new IncomingCallRecovery({
      requestOffer: async (_callId, _negotiationId, _attempt, trigger) => { requests.push(trigger); },
      onPhase: () => undefined,
      onDeadline: () => undefined,
    });
    recovery.begin("call_1", true);
    recovery.markLocalReady("call_1");
    recovery.reconcile("call_1", "accepted", false, "equal_snapshot");
    await vi.advanceTimersByTimeAsync(251);
    expect(requests).toContain("local_media_ready");
  });

  it("uses a fresh negotiation ID for a lost offer retry and stops after an offer arrives", async () => {
    vi.useFakeTimers();
    const negotiations: string[] = [];
    const recovery = new IncomingCallRecovery({
      requestOffer: async (_callId, negotiationId) => { negotiations.push(negotiationId); },
      onPhase: () => undefined,
      onDeadline: () => undefined,
    });
    recovery.begin("call_1", true);
    recovery.markLocalReady("call_1");
    await vi.advanceTimersByTimeAsync(1_751);
    expect(negotiations).toHaveLength(2);
    expect(negotiations[0]).not.toBe(negotiations[1]);
    recovery.offerReceived("call_1", negotiations[1]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(negotiations).toHaveLength(2);
  });

  it("leaves Preparing with a retryable failure at the hard deadline", async () => {
    vi.useFakeTimers();
    const phases: IncomingPhaseUpdate[] = [];
    const deadlines: string[] = [];
    const recovery = new IncomingCallRecovery({
      requestOffer: async () => undefined,
      onPhase: (phase) => phases.push(phase),
      onDeadline: (callId) => deadlines.push(callId),
    }, { deadlineMs: 2_000, maximumOfferRequests: 2 });
    recovery.begin("call_1", false);
    recovery.markLocalReady("call_1");
    await vi.advanceTimersByTimeAsync(2_001);
    expect(deadlines).toEqual(["call_1"]);
    expect(phases.at(-1)?.phase).toBe("failed");
  });

  it("keeps healthy media alive when it connects just before the media deadline", async () => {
    vi.useFakeTimers();
    const phases: IncomingPhaseUpdate[] = [];
    const deadlines: string[] = [];
    const recovery = new IncomingCallRecovery({
      requestOffer: async () => undefined,
      onPhase: (phase) => phases.push(phase),
      onDeadline: (callId) => deadlines.push(callId),
    }, { deadlineMs: 20_000, simAnswerDeadlineMs: 10_000 });
    recovery.begin("call_1", true);
    recovery.markLocalReady("call_1");
    recovery.offerReceived("call_1", "negotiation_1");
    await vi.advanceTimersByTimeAsync(19_500);
    recovery.mediaConnected("call_1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deadlines).toHaveLength(0);
    expect(phases.at(-1)?.phase).toBe("media_connected");
    recovery.simAnswering("call_1");
    await vi.advanceTimersByTimeAsync(2_000);
    recovery.callActive("call_1");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(deadlines).toHaveLength(0);
    expect(phases.at(-1)?.phase).toBe("active");
  });

  it("uses a separate bounded deadline after media connects while Telecom answers", async () => {
    vi.useFakeTimers();
    const phases: IncomingPhaseUpdate[] = [];
    const deadlines: string[] = [];
    const recovery = new IncomingCallRecovery({
      requestOffer: async () => undefined,
      onPhase: (phase) => phases.push(phase),
      onDeadline: (callId) => deadlines.push(callId),
    }, { deadlineMs: 20_000, simAnswerDeadlineMs: 3_000 });
    recovery.begin("call_1", true);
    recovery.mediaConnected("call_1");
    await vi.advanceTimersByTimeAsync(3_001);
    expect(deadlines).toEqual(["call_1"]);
    expect(phases.at(-1)).toMatchObject({ phase: "failed", detail: "Android did not answer the SIM call in time" });
  });
});

describe("Android presence", () => {
  it("does not let a REST refresh overwrite live signaling presence", () => {
    const presence = new AndroidPresenceState();
    presence.setRestOnline(false);
    presence.signalingOpened();
    presence.signalingPresence(true);
    presence.setRestOnline(false);
    expect(presence.label).toBe("Android online");
    expect(presence.authoritative).toBe(true);
  });
});
