/** Prevents callbacks queued by a replaced WebSocket from mutating new pairing state. */
export class SignalingGenerationGuard<T extends object> {
  private generation = 0;
  private pairingId = "";
  private socket: T | undefined;

  begin(pairingId: string): number {
    this.generation += 1;
    this.pairingId = pairingId;
    this.socket = undefined;
    return this.generation;
  }

  isGeneration(generation: number, pairingId: string): boolean {
    return this.generation === generation && this.pairingId === pairingId;
  }

  bind(generation: number, pairingId: string, socket: T): boolean {
    if (!this.isGeneration(generation, pairingId)) return false;
    this.socket = socket;
    return true;
  }

  isCurrent(generation: number, pairingId: string, socket: T): boolean {
    return this.isGeneration(generation, pairingId) && this.socket === socket;
  }

  invalidate(): void {
    this.generation += 1;
    this.pairingId = "";
    this.socket = undefined;
  }
}
