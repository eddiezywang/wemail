import type { MailDatabaseProducer } from "../mail-core/mail-database-producer.js";

/** Shares queue discovery and wakeup across the execution slots. */
export class AiJobDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private dueAt = Infinity;
  private stopped = false;
  private generation = 0;
  private emptyGeneration = -1;
  private blockedUntil = 0;
  private failures = 0;
  private claiming: Promise<unknown> = Promise.resolve();
  private discovering: Promise<void> | null = null;

  constructor(private readonly options: {
    database: Pick<MailDatabaseProducer, "claimJob" | "nextJobDue">;
    kinds: () => string[];
    wake: () => void;
    log: (phase: string, extra: Record<string, unknown>) => void;
  }) {}

  wake(): void {
    if (this.stopped) return;
    if (Date.now() < this.blockedUntil) {
      this.arm(this.blockedUntil);
      return;
    }
    this.generation += 1;
    this.clearTimer();
    this.options.wake();
  }

  claim(...args: Parameters<MailDatabaseProducer["claimJob"]>): ReturnType<MailDatabaseProducer["claimJob"]> {
    const claimed = this.claiming.then(async () => {
      if (this.stopped || this.emptyGeneration === this.generation) return null;
      if (Date.now() < this.blockedUntil) return null;
      const generation = this.generation;
      let job: Awaited<ReturnType<MailDatabaseProducer["claimJob"]>>;
      try {
        job = await this.options.database.claimJob(...args);
        this.failures = 0;
      } catch (error) {
        this.failures += 1;
        this.blockedUntil = Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(this.failures - 1, 4));
        this.arm(this.blockedUntil);
        throw error;
      }
      if (!job) this.emptyGeneration = generation;
      return job;
    });
    this.claiming = claimed.catch(() => undefined);
    return claimed;
  }

  schedule(delayMs?: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (delayMs !== undefined) {
      this.arm(Date.now() + delayMs);
      return Promise.resolve();
    }
    if (this.discovering) return this.discovering;
    const generation = this.generation;
    this.discovering = this.options.database.nextJobDue(this.options.kinds())
      .then((dueAt) => {
        if (generation !== this.generation) return;
        if (dueAt !== null) this.arm(Math.max(Date.now() + 250, dueAt));
      }).catch((error) => {
        this.options.log("canonical-ai-dispatch-due-failed", { error: String(error) });
        this.arm(Date.now() + 5_000);
      }).finally(() => {
        this.discovering = null;
        if (generation !== this.generation) void this.schedule();
      });
    return this.discovering;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private arm(dueAt: number): void {
    dueAt = Math.max(dueAt, this.blockedUntil);
    if (this.stopped || dueAt >= this.dueAt) return;
    this.clearTimer();
    this.dueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dueAt = Infinity;
      this.wake();
    }, Math.min(2_147_483_647, Math.max(1, dueAt - Date.now())));
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = Infinity;
  }
}
