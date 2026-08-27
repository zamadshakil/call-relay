export type IncomingSetupPhase =
  | "idle"
  | "preparing_local"
  | "waiting_android"
  | "waiting_offer"
  | "answering_offer"
  | "ice_connecting"
  | "media_connected"
  | "answering_sim"
  | "active"
  | "failed";

export interface IncomingPhaseUpdate {
  callId: string;
  phase: IncomingSetupPhase;
  detail: string;
  attempt: number;
}

interface RecoveryScheduler {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(timer: number): void;
}

interface IncomingRecoveryHooks {
  requestOffer(callId: string, negotiationId: string, attempt: number, trigger: string): Promise<void>;
  onPhase(update: IncomingPhaseUpdate): void;
  onDeadline(callId: string): void;
}

interface IncomingRecoveryOptions {
  deadlineMs?: number;
  simAnswerDeadlineMs?: number;
  maximumOfferRequests?: number;
  scheduler?: RecoveryScheduler;
}

const defaultScheduler: RecoveryScheduler = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds) as unknown as number,
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

/**
 * Owns the browser side of incoming-call recovery. SDP remains ephemeral: if an
 * offer was missed, this controller repeatedly asks Android to regenerate it.
 */
export class IncomingCallRecovery {
  private readonly mediaDeadlineMs: number;
  private readonly simAnswerDeadlineMs: number;
  private readonly maximumOfferRequests: number;
  private readonly scheduler: RecoveryScheduler;
  private call = "";
  private negotiation = "";
  private currentPhase: IncomingSetupPhase = "idle";
  private phaseDetail = "";
  private accepted = false;
  private localReady = false;
  private offerReady = false;
  private androidOnline: boolean | null = null;
  private attempts = 0;
  private mediaDeadlineTimer: number | undefined;
  private simAnswerDeadlineTimer: number | undefined;
  private retryTimer: number | undefined;

  constructor(private readonly hooks: IncomingRecoveryHooks, options: IncomingRecoveryOptions = {}) {
    this.mediaDeadlineMs = options.deadlineMs ?? 20_000;
    this.simAnswerDeadlineMs = options.simAnswerDeadlineMs ?? 10_000;
    this.maximumOfferRequests = options.maximumOfferRequests ?? 8;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get callId(): string { return this.call; }
  get negotiationId(): string { return this.negotiation; }
  get phase(): IncomingSetupPhase { return this.currentPhase; }

  renderCurrent(): void {
    if (!this.call || this.currentPhase === "idle") return;
    this.hooks.onPhase({ callId: this.call, phase: this.currentPhase, detail: this.phaseDetail, attempt: this.attempts });
  }

  begin(callId: string, alreadyAccepted: boolean, restart = false): void {
    if (!restart && this.call === callId && this.currentPhase !== "idle" && this.currentPhase !== "failed") return;
    this.reset();
    this.call = callId;
    this.negotiation = crypto.randomUUID();
    this.accepted = alreadyAccepted;
    this.mediaDeadlineTimer = this.scheduler.setTimeout(() => {
      if (!this.call || this.currentPhase === "active") return;
      const expiredCall = this.call;
      this.cancelTimers();
      this.setPhase("failed", "Secure audio did not connect in time");
      this.hooks.onDeadline(expiredCall);
    }, this.mediaDeadlineMs);
    this.setPhase("preparing_local", alreadyAccepted ? "Restoring secure audio" : "Preparing secure audio");
  }

  markLocalReady(callId: string): void {
    if (callId !== this.call || this.currentPhase === "failed") return;
    this.localReady = true;
    this.setPhase(this.androidOnline === false ? "waiting_android" : "waiting_offer", this.androidOnline === false
      ? "Waiting for Android relay to reconnect"
      : "Waiting for Android audio offer");
    this.requestMissingOffer("local_media_ready");
  }

  markAccepted(callId: string): void {
    if (callId !== this.call) return;
    this.accepted = true;
    this.requestMissingOffer("call_accepted");
  }

  reconcile(callId: string, state: string, hasRemoteOffer: boolean, trigger: string): void {
    if (state !== "ringing_peer" && state !== "accepted") return;
    if ((this.call !== callId || this.currentPhase === "idle") && state === "accepted") this.begin(callId, true);
    if (this.call !== callId || this.currentPhase === "idle") return;
    this.accepted ||= state === "accepted";
    if (hasRemoteOffer) {
      this.offerReady = true;
      return;
    }
    this.requestMissingOffer(trigger);
  }

  setAndroidPresence(online: boolean): void {
    this.androidOnline = online;
    if (!this.call || this.offerReady || this.currentPhase === "failed") return;
    if (online) this.requestMissingOffer("android_online", true);
    else if (this.localReady) this.setPhase("waiting_android", "Waiting for Android relay to reconnect");
  }

  requestMissingOffer(trigger: string, immediate = false): void {
    if (!this.call || !this.localReady || this.offerReady || this.currentPhase === "failed") return;
    if (immediate && this.retryTimer !== undefined) {
      this.scheduler.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.retryTimer !== undefined) return;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      void this.requestOnce(trigger);
    }, immediate ? 0 : 250);
  }

  offerReceived(callId: string, negotiationId?: string): void {
    if (callId !== this.call) return;
    this.offerReady = true;
    if (negotiationId) this.negotiation = negotiationId;
    this.clearRetry();
    this.setPhase("answering_offer", "Securing Android audio");
  }

  offerHandlingFailed(callId: string, detail: string): void {
    if (callId !== this.call || this.currentPhase === "failed") return;
    this.offerReady = false;
    this.setPhase("waiting_offer", detail);
    this.requestMissingOffer("offer_processing_failed", true);
  }

  restartNegotiation(callId: string, negotiationId: string, trigger: string): void {
    if (callId !== this.call || this.currentPhase === "failed") return;
    this.negotiation = negotiationId;
    this.offerReady = false;
    this.attempts = 0;
    this.clearRetry();
    this.setPhase("waiting_offer", "Recovering secure audio");
    this.requestMissingOffer(trigger, true);
  }

  answerSent(callId: string): void {
    if (callId === this.call) this.setPhase("ice_connecting", "Connecting secure audio");
  }

  mediaConnected(callId: string): void {
    if (callId !== this.call) return;
    this.clearRetry();
    this.clearMediaDeadline();
    this.setPhase("media_connected", "Audio connected; waiting for Android to answer");
    this.scheduleSimAnswerDeadline();
  }

  simAnswering(callId: string): void {
    if (callId !== this.call) return;
    this.setPhase("answering_sim", "Answering Android SIM call");
    this.scheduleSimAnswerDeadline(true);
  }

  callActive(callId: string): void {
    if (callId !== this.call) return;
    this.cancelTimers();
    this.setPhase("active", "Connected");
  }

  fail(callId: string, detail: string): void {
    if (callId !== this.call) return;
    this.cancelTimers();
    this.setPhase("failed", detail);
  }

  reset(callId?: string): void {
    if (callId && callId !== this.call) return;
    this.cancelTimers();
    this.call = "";
    this.negotiation = "";
    this.currentPhase = "idle";
    this.phaseDetail = "";
    this.accepted = false;
    this.localReady = false;
    this.offerReady = false;
    this.attempts = 0;
  }

  private async requestOnce(trigger: string): Promise<void> {
    if (!this.call || !this.localReady || this.offerReady || this.currentPhase === "failed") return;
    if (this.androidOnline === false) {
      this.setPhase("waiting_android", "Waiting for Android relay to reconnect");
      this.scheduleRetry(trigger, 1_000);
      return;
    }
    if (this.attempts >= this.maximumOfferRequests) return;
    const attempt = ++this.attempts;
    if (attempt > 1) this.negotiation = crypto.randomUUID();
    const callId = this.call;
    const negotiationId = this.negotiation;
    this.setPhase("waiting_offer", `Waiting for Android audio offer · attempt ${attempt}`);
    try {
      await this.hooks.requestOffer(callId, negotiationId, attempt, trigger);
    } catch {
      // WebSocket send failures are recoverable. The next attempt reconnects.
    }
    if (callId === this.call && !this.offerReady) {
      this.scheduleRetry("offer_retry", Math.min(4_000, 1_500 * attempt));
    }
  }

  private scheduleRetry(trigger: string, delay: number): void {
    if (this.retryTimer !== undefined || this.offerReady || this.currentPhase === "failed") return;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      void this.requestOnce(trigger);
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private cancelTimers(): void {
    this.clearRetry();
    this.clearMediaDeadline();
    if (this.simAnswerDeadlineTimer !== undefined) this.scheduler.clearTimeout(this.simAnswerDeadlineTimer);
    this.simAnswerDeadlineTimer = undefined;
  }

  private clearMediaDeadline(): void {
    if (this.mediaDeadlineTimer !== undefined) this.scheduler.clearTimeout(this.mediaDeadlineTimer);
    this.mediaDeadlineTimer = undefined;
  }

  private scheduleSimAnswerDeadline(rebase = false): void {
    if (rebase && this.simAnswerDeadlineTimer !== undefined) {
      this.scheduler.clearTimeout(this.simAnswerDeadlineTimer);
      this.simAnswerDeadlineTimer = undefined;
    }
    if (this.simAnswerDeadlineTimer !== undefined || !this.call || this.currentPhase === "active") return;
    this.simAnswerDeadlineTimer = this.scheduler.setTimeout(() => {
      if (!this.call || this.currentPhase === "active") return;
      const expiredCall = this.call;
      this.cancelTimers();
      this.setPhase("failed", "Android did not answer the SIM call in time");
      this.hooks.onDeadline(expiredCall);
    }, this.simAnswerDeadlineMs);
  }

  private setPhase(phase: IncomingSetupPhase, detail: string): void {
    this.currentPhase = phase;
    this.phaseDetail = detail;
    this.hooks.onPhase({ callId: this.call, phase, detail, attempt: this.attempts });
  }
}

export class KeyedSingleFlight<T> {
  private active: { key: string; promise: Promise<T> } | undefined;

  get activeKey(): string | undefined { return this.active?.key; }

  run(key: string, factory: () => Promise<T>): Promise<T> {
    if (this.active?.key === key) return this.active.promise;
    const promise = factory();
    const entry = { key, promise };
    this.active = entry;
    void promise.finally(() => {
      if (this.active === entry) this.active = undefined;
    }).catch(() => undefined);
    return promise;
  }

  clear(key?: string): void {
    if (!key || this.active?.key === key) this.active = undefined;
  }
}

/** Live signaling presence wins over the slower REST last-seen approximation. */
export class AndroidPresenceState {
  private restOnline = false;
  private socketConnected = false;
  private liveOnline: boolean | null = null;

  setRestOnline(online: boolean): void { this.restOnline = online; }
  signalingOpened(): void { this.socketConnected = true; this.liveOnline = null; }
  signalingPresence(online: boolean): void { this.socketConnected = true; this.liveOnline = online; }
  signalingClosed(): void { this.socketConnected = false; this.liveOnline = null; }

  get online(): boolean { return this.socketConnected && this.liveOnline === true; }
  get authoritative(): boolean { return this.socketConnected && this.liveOnline !== null; }
  get label(): string {
    if (this.socketConnected && this.liveOnline === null) return "Checking Android connection…";
    if (this.online) return "Android online";
    if (this.socketConnected) return "Android offline";
    return this.restOnline ? "Android recently active · signaling disconnected" : "Android offline";
  }
}
