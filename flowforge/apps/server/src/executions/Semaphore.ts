/** Per-key concurrency limiter for in-process executions. */
export class KeyedSemaphore {
  private readonly running = new Map<string, number>();
  private readonly queues = new Map<string, Array<() => void>>();

  async acquire(key: string, limit: number): Promise<() => void> {
    const current = this.running.get(key) ?? 0;
    if (current >= limit) {
      await new Promise<void>((resolve) => {
        const queue = this.queues.get(key) ?? [];
        queue.push(resolve);
        this.queues.set(key, queue);
      });
    } else {
      this.running.set(key, current + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queues.get(key)?.shift();
      if (next)
        next(); // hand the slot over
      else {
        const n = (this.running.get(key) ?? 1) - 1;
        if (n <= 0) this.running.delete(key);
        else this.running.set(key, n);
      }
    };
  }

  waiting(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }
}
