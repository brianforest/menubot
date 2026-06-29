/** A span of wall-clock time spent in one labelled pipeline stage. */
export interface Span {
  label: string;
  ms: number;
}

/**
 * Minimal stopwatch for per-stage pipeline timing. Wrap an await with
 * `time(label, fn)` and read the breakdown via `format()` / `total()` / `spans`.
 * The clock is injectable so tests stay deterministic.
 */
export class Timer {
  private readonly marks: Span[] = [];
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Run `fn`, record how long it took under `label`, and pass its value through.
   *  The span is recorded even if `fn` throws (so a failing stage is still timed). */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.marks.push({ label, ms: this.now() - t0 });
    }
  }

  /** Record a span that was measured elsewhere. */
  add(label: string, ms: number): void {
    this.marks.push({ label, ms });
  }

  get spans(): ReadonlyArray<Span> {
    return this.marks;
  }

  /** Sum of all recorded spans, in milliseconds. */
  total(): number {
    return this.marks.reduce((n, m) => n + m.ms, 0);
  }

  /** e.g. "extract 210.3s · enrich 95.1s · publish 2.0s". */
  format(): string {
    return this.marks
      .map((m) => `${m.label} ${(m.ms / 1000).toFixed(1)}s`)
      .join(" · ");
  }
}
