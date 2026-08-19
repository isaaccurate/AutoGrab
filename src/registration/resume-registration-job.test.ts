import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SQLiteRegistrationJobStore } from "../jobs/sqlite-job-store.js";
import type { TrustedSeatNotification } from "../notifications/notify-uw-parser.js";
import { resumeRegistrationJob } from "./resume-registration-job.js";
import type { LiveRegistrationPageDriver } from "./uw-registration-page.js";

const directories: string[] = [];
const stores: SQLiteRegistrationJobStore[] = [];

async function createStore(): Promise<SQLiteRegistrationJobStore> {
  const directory = await mkdtemp(join(tmpdir(), "autograb-resume-"));
  directories.push(directory);
  const store = new SQLiteRegistrationJobStore(join(directory, "autograb.sqlite"));
  stores.push(store);
  return store;
}

function queue(store: SQLiteRegistrationJobStore) {
  const notification: TrustedSeatNotification = {
    sourceUidValidity: "99",
    sourceUid: "101",
    sourceMessageId: "<resume@example.test>",
    course: "TEST 101 A",
    sln: "12345",
    receivedAt: new Date("2026-08-20T18:00:00.000Z"),
  };
  return store.enqueueValidatedNotification({
    mailboxAccount: "student@gmail.com",
    notification,
  }).job;
}

function options(
  store: SQLiteRegistrationJobStore,
  jobId: string,
  overrides: Partial<Parameters<typeof resumeRegistrationJob>[0]> = {},
) {
  const page = {} as LiveRegistrationPageDriver;
  return {
    store,
    browser: {
      startLive: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    },
    alerts: { send: async () => undefined },
    gate: { assertClear: vi.fn(() => undefined) },
    targetQuarter: "au26",
    allowedTargets: [{ key: "12345", slns: ["12345"] }],
    jobId,
    workerId: "resume-test",
    waitUntilReady: vi.fn(async () => "ready" as const),
    ...overrides,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resumeRegistrationJob", () => {
  it("continues the exact queued job through the normal live runner", async () => {
    const store = await createStore();
    const job = queue(store);
    const runLive = vi.fn(async (runOptions) => {
      const claimed = store.claimSpecificJobForLiveAttempt(
        runOptions.jobId,
        runOptions.authorizedTargetKey,
        runOptions.workerId,
      );
      return {
        status: "succeeded" as const,
        job: store.completeRunningJob(claimed.id, "succeeded"),
      };
    });
    const resumeOptions = options(store, job.id, { runLive });

    await expect(resumeRegistrationJob(resumeOptions)).resolves.toMatchObject({
      status: "succeeded",
      job: { id: job.id, state: "succeeded" },
    });
    expect(runLive).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        authorizedTargetKey: "12345",
        initialPageState: "ready",
      }),
    );
    expect(resumeOptions.browser.close).toHaveBeenCalledOnce();
  });

  it("rejects non-queued or non-allowlisted jobs before opening Chromium", async () => {
    const store = await createStore();
    const job = queue(store);
    const nonAllowlisted = options(store, job.id, { allowedTargets: [] });

    await expect(resumeRegistrationJob(nonAllowlisted)).rejects.toThrow(
      "no longer allowlisted",
    );
    expect(nonAllowlisted.browser.startLive).not.toHaveBeenCalled();

    store.claimSpecificJobForLiveAttempt(job.id, job.targetKey, "test-worker");
    store.completeRunningJob(job.id, "failed", {
      failureCode: "seat_unavailable",
    });
    const failed = options(store, job.id);
    await expect(resumeRegistrationJob(failed)).rejects.toThrow("Only a queued");
    expect(failed.browser.startLive).not.toHaveBeenCalled();
  });

  it("keeps the queued job unchanged when login is still required", async () => {
    const store = await createStore();
    const job = queue(store);
    const runLive = vi.fn(async () => ({
      status: "browser_not_ready" as const,
      pageState: "login_required" as const,
    }));
    const resumeOptions = options(store, job.id, {
      waitUntilReady: async () => "login_required",
      runLive,
    });

    await expect(resumeRegistrationJob(resumeOptions)).resolves.toEqual({
      status: "browser_not_ready",
      pageState: "login_required",
    });
    expect(store.getJob(job.id)?.state).toBe("queued");
    expect(resumeOptions.browser.close).toHaveBeenCalledOnce();
  });
});
