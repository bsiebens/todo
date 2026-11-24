/**
 * Hybrid logical clock. A stamp is "<ms, 15 digits>:<counter, 4 base-36>:<node>",
 * so comparing stamps as strings orders them: wall time first, then a counter
 * for events in the same millisecond, then the node id as a tie-breaker.
 */
export class Hlc {
  private ms = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    last?: string | null,
    private clock: () => number = Date.now,
  ) {
    if (last) this.observe(last);
  }

  static parse(stamp: string): { ms: number; counter: number; node: string } {
    const [ms, counter, ...node] = stamp.split(':');
    return { ms: Number(ms), counter: parseInt(counter ?? '0', 36), node: node.join(':') };
  }

  static format(ms: number, counter: number, node: string): string {
    return `${String(ms).padStart(15, '0')}:${counter.toString(36).padStart(4, '0')}:${node}`;
  }

  /** A new stamp, later than every stamp issued or seen before. */
  now(): string {
    const wall = this.clock();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return Hlc.format(this.ms, this.counter, this.node);
  }

  /** Moves the clock past a stamp from elsewhere, so later local stamps sort after it. */
  observe(stamp: string): void {
    const { ms, counter } = Hlc.parse(stamp);
    if (!Number.isFinite(ms)) return;
    if (ms > this.ms || (ms === this.ms && counter > this.counter)) {
      this.ms = ms;
      this.counter = counter;
    }
  }

  get last(): string {
    return Hlc.format(this.ms, this.counter, this.node);
  }
}
