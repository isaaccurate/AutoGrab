import type { RegistrationJob } from "../jobs/sqlite-job-store.js";
import {
  runLiveRegistrationAttempt,
  type LiveRegistrationGate,
  type LiveRegistrationResult,
  type LiveRegistrationRunnerOptions,
} from "./live-registration-runner.js";
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

export interface RegistrationResumeBrowser {
  startLive(): Promise<LiveRegistrationPageDriver>;
  close(): Promise<void>;
}

export interface ResumeRegistrationJobOptions {
  readonly store: LiveRegistrationRunnerOptions["store"];
  readonly browser: RegistrationResumeBrowser;
  readonly alerts: RegistrationAlertSink;
  readonly gate: LiveRegistrationGate;
  readonly targetQuarter: string;
  readonly allowedTargets:
    | readonly RegistrationTarget[]
    | (() => readonly RegistrationTarget[]);
  readonly jobId: string;
  readonly workerId: string;
  readonly waitUntilReady?: (
    page: LiveRegistrationPageDriver,
    targetQuarter: string,
  ) => Promise<RegistrationPageState>;
  readonly runLive?: typeof runLiveRegistrationAttempt;
}

function currentTargets(
  source: ResumeRegistrationJobOptions["allowedTargets"],
): readonly RegistrationTarget[] {
  return typeof source === "function" ? source() : source;
}

function requireResumableJob(
  options: ResumeRegistrationJobOptions,
): RegistrationJob {
  const job = options.store.getJob(options.jobId);
  if (!job) throw new Error("The registration job was not found.");
  if (job.state !== "queued") {
    throw new Error("Only a queued registration job can be resumed.");
  }
  if (
    !hasRegistrationTarget(currentTargets(options.allowedTargets), {
      key: job.targetKey,
      slns: job.slns,
    })
  ) {
    throw new Error("The queued registration target is no longer allowlisted.");
  }
  return job;
}

export async function resumeRegistrationJob(
  options: ResumeRegistrationJobOptions,
): Promise<LiveRegistrationResult> {
  const job = requireResumableJob(options);
  options.gate.assertClear();

  try {
    const page = await options.browser.startLive();
    const waitUntilReady =
      options.waitUntilReady ?? waitForRegistrationPageReady;
    const pageState = await waitUntilReady(page, options.targetQuarter);
    return await (options.runLive ?? runLiveRegistrationAttempt)({
      store: options.store,
      page,
      alerts: options.alerts,
      gate: options.gate,
      targetQuarter: options.targetQuarter,
      allowedTargets: options.allowedTargets,
      jobId: job.id,
      authorizedTargetKey: job.targetKey,
      workerId: options.workerId,
      initialPageState: pageState,
    });
  } finally {
    await options.browser.close();
  }
}
