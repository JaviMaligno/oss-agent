/**
 * Semaphore for controlling concurrent access to resources.
 * Used by ParallelOrchestrator to limit concurrent agents.
 */
export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) {
      throw new Error("Semaphore max must be at least 1");
    }
  }

  /**
   * Acquire a slot. Resolves immediately if available,
   * otherwise waits until a slot is released.
   */
  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a slot. If there are waiting acquires, the next one is resolved.
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Don't decrement current - we're passing the slot to the next waiter
      next();
    } else {
      this.current--;
    }
  }

  /**
   * Number of available slots.
   */
  available(): number {
    return Math.max(0, this.max - this.current);
  }

  /**
   * Number of pending acquires waiting for a slot.
   */
  waiting(): number {
    return this.queue.length;
  }

  /**
   * Current number of acquired slots.
   */
  acquired(): number {
    return this.current;
  }

  /**
   * Maximum number of concurrent slots.
   */
  getMax(): number {
    return this.max;
  }
}
