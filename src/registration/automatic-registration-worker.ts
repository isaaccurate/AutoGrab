import type {
  RegistrationJob,
  SQLiteRegistrationJobStore,
} from "../jobs/sqlite-job-store.js";
import type { LiveRegistrationGate } from "./live-registration-runner.js";
import {
  runLiveRegistrationAttempt,
  type LiveRegistrationResult,
} from "./live-registration-runner.js";
import type { UwPlaywrightBrowser } from "./playwright-browser.js";
import type { RegistrationAlertSink } from "./registration-alerts.js";
import {
  hasRegistrationTarget,
  type RegistrationTarget,
} from "./registration-target.js";
import {
  waitForRegistrationPageReady,
  type LiveRegistrationPageDriver,
  type RegistrationPageState,
} from "./uw-registration-page.js";

interface AutomaticBrowserSession {
  startLive(): Promise<LiveRegistrationPageDriver>;
  close(): Promise<void>;
}

type LiveRunner = typeof runLiveRegistrationAttempt;

export interface AutomaticRegistrationWorkerOptions {
  readonly store: Pick<
    SQLiteRegistrationJobStore,
    | "claimSpecificJobForLiveAttempt"
    | "completeRunningJob"
    | "getJob"
  >;
  readonly targetQuarter: string;
  readonly allowedTargets:
    | readonly RegistrationTarget[]
    | (() => readonly RegistrationTarget[]);
  readonly maxJobAgeMs: number;
  readonly alerts: RegistrationAlertSink;
  readonly gate: LiveRegistrationGate;
  readonly browserFactory: () => AutomaticBrowserSession;
  readonly runLive?: LiveRunner;
  readonly waitUntilReady?: (
    page: LiveRegistrationPageDriver,
    targetQuarter: string,
  ) => Promise<RegistrationPageState>;
  readonly onResult?: (
    result: LiveRegistrationResult,
    job: RegistrationJob,
  ) => void;
  readonly onFailure?: (job: RegistrationJob) => void;
  readonly now?: () => number;
}

export class AutomaticRegistrationWorker {
  private readonly pendingJobIds = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private stopping = false;
  private sequence = 0;

  constructor(private readonly options: AutomaticRegistrationWorkerOptions) {}

  enqueue(job: RegistrationJob): boolean {
    const allowedTargets =
      typeof this.options.allowedTargets === "function"
        ? this.options.allowedTargets()
        : this.options.allowedTargets;
    if (
      this.stopping ||
      job.state !== "queued" ||
      !hasRegistrationTarget(allowedTargets, {
        key: job.targetKey,
        slns: job.slns,
      }) ||
      (this.options.now ?? Date.now)() - job.createdAt.getTime() >
        this.options.maxJobAgeMs ||
      this.pendingJobIds.has(job.id)
    ) {
      return false;
    }
    this.pendingJobIds.add(job.id);
    this.tail = this.tail.then(() => this.runOne(job)).catch(() => {
      this.options.onFailure?.(job);
    }).finally(() => {
      this.pendingJobIds.delete(job.id);
    });
    return true;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.tail;
  }

  private async runOne(job: RegistrationJob): Promise<void> {
    if (this.stopping) return;
    const current = this.options.store.getJob(job.id);
    if (
      !current ||
      current.state !== "queued" ||
      current.targetKey !== job.targetKey
    ) return;

    const browser = this.options.browserFactory();
    try {
      const page = await browser.startLive();
      const waitUntilReady =
        this.options.waitUntilReady ?? waitForRegistrationPageReady;
      const pageState = await waitUntilReady(page, this.options.targetQuarter);
      this.sequence += 1;
      const result = await (this.options.runLive ?? runLiveRegistrationAttempt)({
        store: this.options.store,
        page,
        alerts: this.options.alerts,
        gate: this.options.gate,
        targetQuarter: this.options.targetQuarter,
        allowedTargets: this.options.allowedTargets,
        jobId: current.id,
        authorizedTargetKey: current.targetKey,
        workerId: `automatic_${process.pid}_${this.sequence}`,
        initialPageState: pageState,
      });
      this.options.onResult?.(result, current);
    } finally {
      await browser.close();
    }
  }
}

export type AutomaticRegistrationBrowserFactory = () => Pick<
  UwPlaywrightBrowser,
  "startLive" | "close"
>;
