/**
 * Applies only the newest authoritative read. Foreground, WebSocket-open, and
 * WebSocket-hello recovery hooks can overlap on Safari; a delayed older read
 * must never overwrite a newer server snapshot (including a newer null).
 */
export class LatestAuthoritativeRecovery<T> {
  private generation = 0;

  async run(load: () => Promise<T>, commit: (value: T) => Promise<void> | void): Promise<boolean> {
    const generation = ++this.generation;
    const value = await load();
    if (generation !== this.generation) return false;
    await commit(value);
    return generation === this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }
}
