/**
 * One scan runs at a time on the 1 GB VM. A few more may wait. Anything beyond that is
 * turned away at once, so a burst of traffic cannot pile up work.
 */
export class ScanQueue {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly maxActive = 1, private readonly maxWaiting = 5) {}

  /** Returns null when the queue is full. Otherwise resolves with a release function. */
  tryEnter(): Promise<() => void> | null {
    if (this.active < this.maxActive) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.maxWaiting) return null;
    return new Promise((resolve) => {
      this.waiting.push(() => resolve(this.releaser()));
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); // the slot passes straight to the next in line
      else this.active--;
    };
  }
}
