import type {
  RegistrationJob,
  SQLiteRegistrationJobStore,
} from "../jobs/sqlite-job-store.js";
import {
  classifyRegistrationPage,
  prepareSlnsForCart,
  type LiveRegistrationPageDriver,
  type RegistrationPageState,
} from "./uw-registration-page.js";
import {
  hasRegistrationTarget,
  type RegistrationTarget,
} from "./registration-target.js";
import type {
  RegistrationAlert,
  RegistrationAlertSink,
} from "./registration-alerts.js";

export type LiveRegistrationResult =
  | { readonly status: "browser_not_ready"; readonly pageState: RegistrationPageState }
  | { readonly status: "succeeded"; readonly job: RegistrationJob }
  | { readonly status: "failed"; readonly job: RegistrationJob }
  | { readonly status: "uncertain"; readonly job: RegistrationJob }
  | { readonly status: "blocked"; readonly job: RegistrationJob };

export interface LiveRegistrationGate {
  assertClear(): void;
}

export interface LiveRegistrationRunnerOptions {
  readonly store: Pick<
    SQLiteRegistrationJobStore,
    | "claimSpecificJobForLiveAttempt"
    | "completeRunningJob"
    | "getJob"
  >;
  readonly page: LiveRegistrationPageDriver;
  readonly alerts: RegistrationAlertSink;
  readonly gate: LiveRegistrationGate;
  readonly targetQuarter: string;
  readonly allowedTargets:
    | readonly RegistrationTarget[]
    | (() => readonly RegistrationTarget[]);
  readonly jobId: string;
  readonly authorizedTargetKey: string;
  readonly workerId: string;
  readonly cartTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly initialPageState?: RegistrationPageState;
}

function currentAllowedTargets(
  source: LiveRegistrationRunnerOptions["allowedTargets"],
): readonly RegistrationTarget[] {
  return typeof source === "function" ? source() : source;
}

type DefinitiveResult =
  | { readonly state: "succeeded" }
  | { readonly state: "failed"; readonly failureCode: string }
  | { readonly state: "uncertain"; readonly failureCode: string };

function knownFailureCode(messages: readonly string[]): string | null {
  const text = messages.join(" ").replace(/\s+/g, " ");
  if (/related (?:lab|quiz|lecture)|must also register/i.test(text)) {
    return "linked_section_required";
  }
  if (/meets at the same time|time conflict|overlapping meeting/i.test(text)) {
    return "time_conflict";
  }
  if (/full|closed|no seats|not available/i.test(text)) {
    return "seat_unavailable";
  }
  if (!/registration failed|schedule not updated/i.test(text)) return null;
  return "registration_rejected";
}

function hasSuccessConfirmation(messages: readonly string[]): boolean {
  const text = messages.join(" ").replace(/\s+/g, " ");
  return /registration (?:was )?successful|successfully registered|schedule (?:has been |was )?updated/i.test(
    text,
  );
}

async function emitAlert(
  sink: RegistrationAlertSink,
  job: RegistrationJob,
): Promise<void> {
  const alert: RegistrationAlert = {
    state: job.state as RegistrationAlert["state"],
    course: job.course,
    sln: job.sln,
    slns: job.slns,
    failureCode: job.failureCode,
  };
  await sink.send(alert).catch(() => undefined);
}

function assertJobMayContinue(
  options: LiveRegistrationRunnerOptions,
  jobId: string,
): void {
  options.gate.assertClear();
  const current = options.store.getJob(jobId);
  if (!current || current.state !== "running") {
    throw new Error("The live registration job is no longer running.");
  }
  if (current.cancellationRequestedAt !== null) {
    throw new Error("The live registration job was cancelled.");
  }
}

async function waitForCart(
  options: LiveRegistrationRunnerOptions,
  sln: string,
): Promise<boolean> {
  const timeoutMs = options.cartTimeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  do {
    assertJobMayContinue(options, options.jobId);
    if (await options.page.cartContainsSln(sln)) return true;
    await sleep(pollIntervalMs);
  } while (now() - startedAt < timeoutMs);
  return false;
}

async function waitForResult(
  options: LiveRegistrationRunnerOptions,
  slns: readonly string[],
): Promise<DefinitiveResult> {
  const timeoutMs = options.resultTimeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  do {
    options.gate.assertClear();
    try {
      const messages = await options.page.registrationMessages();
      const failureCode = knownFailureCode(messages);
      if (failureCode) return { state: "failed", failureCode };
      const registered = await options.page.registeredSlns();
      if (
        hasSuccessConfirmation(messages) &&
        slns.every((sln) => registered.includes(sln))
      ) {
        return { state: "succeeded" };
      }
    } catch {
      // Navigation may briefly replace the SPA document after submission.
    }
    await sleep(pollIntervalMs);
  } while (now() - startedAt < timeoutMs);
  return { state: "uncertain", failureCode: "result_timeout" };
}

export async function runLiveRegistrationAttempt(
  options: LiveRegistrationRunnerOptions,
): Promise<LiveRegistrationResult> {
  const pending = options.store.getJob(options.jobId);
  if (
    !pending ||
    pending.targetKey !== options.authorizedTargetKey ||
    !hasRegistrationTarget(currentAllowedTargets(options.allowedTargets), {
      key: pending.targetKey,
      slns: pending.slns,
    })
  ) {
    throw new Error(
      "The live-authorized registration target is not allowlisted.",
    );
  }
  const pageState =
    options.initialPageState ??
    (await classifyRegistrationPage(options.page, options.targetQuarter));
  if (pageState !== "ready") {
    if (pageState === "login_required") {
      if (pending.targetKey === options.authorizedTargetKey) {
        await options.alerts.send({
          state: "login_required",
          course: pending.course,
          sln: pending.sln,
          slns: pending.slns,
          failureCode: "browser_login_required",
        }).catch(() => undefined);
      }
    }
    return { status: "browser_not_ready", pageState };
  }
  options.gate.assertClear();

  const claimed = options.store.claimSpecificJobForLiveAttempt(
    options.jobId,
    options.authorizedTargetKey,
    options.workerId,
    { leaseMs: 5 * 60 * 1_000 },
  );
  let submissionStarted = false;

  try {
    assertJobMayContinue(options, claimed.id);
    if (
      (await classifyRegistrationPage(options.page, options.targetQuarter)) !==
      "ready"
    ) {
      throw new Error("The registration page changed after the job was claimed.");
    }
    const prepared = await prepareSlnsForCart(options.page, claimed.slns);
    if (prepared.status === "already_registered") {
      const completed = options.store.completeRunningJob(claimed.id, "succeeded", {
        detail: "All target SLNs were already present in the registered schedule.",
      });
      await emitAlert(options.alerts, completed);
      return { status: "succeeded", job: completed };
    }
    assertJobMayContinue(options, claimed.id);
    await options.page.addToCart();
    for (const sln of prepared.slns) {
      if (!(await waitForCart(options, sln))) {
        const blocked = options.store.completeRunningJob(claimed.id, "blocked", {
          failureCode: "cart_verification_failed",
          detail: "A target SLN did not appear in the registration cart.",
        });
        await emitAlert(options.alerts, blocked);
        return { status: "blocked", job: blocked };
      }
    }

    assertJobMayContinue(options, claimed.id);
    if (
      !hasRegistrationTarget(currentAllowedTargets(options.allowedTargets), {
        key: claimed.targetKey,
        slns: claimed.slns,
      })
    ) {
      throw new Error(
        "The registration target was removed from the runtime allowlist.",
      );
    }
    submissionStarted = true;
    await options.page.submitUpdateSchedule();
    const result = await waitForResult(options, claimed.slns);
    if (result.state === "succeeded") {
      const completed = options.store.completeRunningJob(
        claimed.id,
        "succeeded",
        {
          detail:
            "All target SLNs appeared in the registered schedule after submission.",
        },
      );
      await emitAlert(options.alerts, completed);
      return { status: "succeeded", job: completed };
    }

    const completed = options.store.completeRunningJob(
      claimed.id,
      result.state,
      {
        failureCode: result.failureCode,
        detail:
          result.state === "failed"
            ? "Register.UW reported that the schedule was not updated."
            : "No authoritative registration result appeared before timeout.",
      },
    );
    await emitAlert(options.alerts, completed);
    return { status: result.state, job: completed };
  } catch {
    const current = options.store.getJob(claimed.id);
    if (!current || current.state !== "running") throw new Error("The live attempt stopped after state changed.");
    const outcome = submissionStarted ? "uncertain" : "blocked";
    const failureCode = submissionStarted
      ? "submission_interrupted"
      : "pre_submission_stopped";
    const completed = options.store.completeRunningJob(claimed.id, outcome, {
      failureCode,
      detail: submissionStarted
        ? "The attempt was interrupted after submission began."
        : "The attempt stopped before schedule submission.",
    });
    await emitAlert(options.alerts, completed);
    return { status: outcome, job: completed };
  }
}
