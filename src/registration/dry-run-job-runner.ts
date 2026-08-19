import type {
  RegistrationJob,
  SQLiteRegistrationJobStore,
} from "../jobs/sqlite-job-store.js";
import {
  classifyRegistrationPage,
  prepareRegistrationDryRun,
  type RegistrationPageDriver,
  type RegistrationPageState,
} from "./uw-registration-page.js";

export type RegistrationDryRunResult =
  | { readonly status: "browser_not_ready"; readonly pageState: RegistrationPageState }
  | { readonly status: "no_job" }
  | { readonly status: "prepared"; readonly job: RegistrationJob }
  | { readonly status: "already_registered"; readonly job: RegistrationJob }
  | { readonly status: "blocked"; readonly job: RegistrationJob; readonly reason: string };

export interface RegistrationDryRunOptions {
  readonly store: Pick<
    SQLiteRegistrationJobStore,
    "claimNextJob" | "completeRunningJob"
  >;
  readonly page: RegistrationPageDriver;
  readonly targetQuarter: string;
  readonly allowedSlns: readonly string[];
  readonly workerId: string;
  readonly installGuards: () => Promise<void>;
  readonly initialPageState?: RegistrationPageState;
}

function failureCodeForState(state: RegistrationPageState): string {
  switch (state) {
    case "login_required":
      return "browser_login_required";
    case "wrong_quarter":
      return "browser_wrong_quarter";
    case "unavailable":
      return "browser_form_unavailable";
    case "ready":
      return "browser_ready";
  }
}

export async function runRegistrationDryRunJob(
  options: RegistrationDryRunOptions,
): Promise<RegistrationDryRunResult> {
  const initialState =
    options.initialPageState ??
    (await classifyRegistrationPage(options.page, options.targetQuarter));
  if (initialState !== "ready") {
    return { status: "browser_not_ready", pageState: initialState };
  }

  await options.installGuards();
  const job = options.store.claimNextJob(options.workerId, {
    leaseMs: 5 * 60 * 1_000,
  });
  if (!job) return { status: "no_job" };

  if (!job.slns.every((sln) => options.allowedSlns.includes(sln))) {
    const blocked = options.store.completeRunningJob(job.id, "blocked", {
      failureCode: "sln_not_allowlisted",
      detail: "The queued SLN is no longer in the configured allowlist.",
    });
    return {
      status: "blocked",
      job: blocked,
      reason: "sln_not_allowlisted",
    };
  }

  if (job.slns.length > 1) {
    const blocked = options.store.completeRunningJob(job.id, "blocked", {
      failureCode: "dry_run_bundle_requires_cart",
      detail: "A bundle cannot be represented safely by the single-field dry run.",
    });
    return {
      status: "blocked",
      job: blocked,
      reason: "dry_run_bundle_requires_cart",
    };
  }

  try {
    const prepared = await prepareRegistrationDryRun(
      options.page,
      options.targetQuarter,
      job.sln,
    );
    if (prepared.status === "already_registered") {
      const completed = options.store.completeRunningJob(job.id, "succeeded", {
        detail: "The SLN was already present in the registered schedule.",
      });
      return { status: "already_registered", job: completed };
    }
    if (prepared.status !== "prepared") {
      const reason = failureCodeForState(prepared.status);
      const blocked = options.store.completeRunningJob(job.id, "blocked", {
        failureCode: reason,
        detail: "The registration page was not safe to prepare.",
      });
      return { status: "blocked", job: blocked, reason };
    }

    const blocked = options.store.completeRunningJob(job.id, "blocked", {
      failureCode: "dry_run_submission_disabled",
      detail: "The SLN was filled, but all registration submission was disabled.",
    });
    return { status: "prepared", job: blocked };
  } catch (error) {
    try {
      options.store.completeRunningJob(job.id, "blocked", {
        failureCode: "dry_run_preparation_failed",
        detail: "Dry-run preparation failed before any submission capability was used.",
      });
    } catch {
      // Startup recovery will conservatively classify an unresolved lease.
    }
    throw error;
  }
}
