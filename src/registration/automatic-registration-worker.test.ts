import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SQLiteRegistrationJobStore } from "../jobs/sqlite-job-store.js";
import type { TrustedSeatNotification } from "../notifications/notify-uw-parser.js";
import { AutomaticRegistrationWorker } from "./automatic-registration-worker.js";
import type { LiveRegistrationResult } from "./live-registration-runner.js";
import type { LiveRegistrationPageDriver } from "./uw-registration-page.js";

const directories: string[] = [];
const stores: SQLiteRegistrationJobStore[] = [];

async function createStore(): Promise<SQLiteRegistrationJobStore> {
  const directory = await mkdtemp(join(tmpdir(), "autograb-automatic-"));
  directories.push(directory);
  const store = new SQLiteRegistrationJobStore(join(directory, "autograb.sqlite"));
  stores.push(store);
  return store;
}

function queue(
  store: SQLiteRegistrationJobStore,
  sln: string,
  uid: string,
) {
  const notification: TrustedSeatNotification = {
    sourceUidValidity: "99",
    sourceUid: uid,
    sourceMessageId: `<automatic-${uid}@example.test>`,
    course: `TEST ${uid} A`,
    sln,
    receivedAt: new Date("2026-08-18T20:00:00.000Z"),
  };
  return store.enqueueValidatedNotification({
    mailboxAccount: "student@gmail.com",
    notification,
  }).job;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AutomaticRegistrationWorker", () => {
  it("deduplicates dispatch and serializes live attempts", async () => {
    const store = await createStore();
    const first = queue(store, "12345", "101");
    const second = queue(store, "54321", "102");
    const releases = [deferred(), deferred()];
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const close = vi.fn(async () => undefined);
    const onResult = vi.fn();
    const runLive = vi.fn(async (options): Promise<LiveRegistrationResult> => {
      const index = order.length;
      order.push(options.jobId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await releases[index]!.promise;
      active -= 1;
      const claimed = store.claimSpecificJobForLiveAttempt(
        options.jobId,
        options.authorizedTargetKey,
        options.workerId,
      );
      const completed = store.completeRunningJob(claimed.id, "succeeded");
      return { status: "succeeded", job: completed };
    });
    const worker = new AutomaticRegistrationWorker({
      store,
      targetQuarter: "au26",
      allowedTargets: [
        { key: "12345", slns: ["12345"] },
        { key: "54321", slns: ["54321"] },
      ],
      maxJobAgeMs: 60_000,
      now: () => first.createdAt.getTime(),
      alerts: { send: async () => undefined },
      gate: { assertClear: () => undefined },
      browserFactory: () => ({
        startLive: async () => ({} as LiveRegistrationPageDriver),
        close,
      }),
      waitUntilReady: async () => "ready",
      runLive,
      onResult,
    });

    expect(worker.enqueue(first)).toBe(true);
    expect(worker.enqueue(first)).toBe(false);
    expect(worker.enqueue(second)).toBe(true);
    await vi.waitFor(() => expect(runLive).toHaveBeenCalledTimes(1));
    releases[0]!.resolve();
    await vi.waitFor(() => expect(runLive).toHaveBeenCalledTimes(2));
    releases[1]!.resolve();
    await worker.drain();

    expect(order).toEqual([first.id, second.id]);
    expect(maximumActive).toBe(1);
    expect(runLive.mock.calls[0]?.[0].initialPageState).toBe("ready");
    expect(onResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "succeeded" }),
      first,
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("continues to the next queued job after a safe worker failure", async () => {
    const store = await createStore();
    const first = queue(store, "12345", "101");
    const second = queue(store, "54321", "102");
    const failed: string[] = [];
    const attempted: string[] = [];
    const worker = new AutomaticRegistrationWorker({
      store,
      targetQuarter: "au26",
      allowedTargets: [
        { key: "12345", slns: ["12345"] },
        { key: "54321", slns: ["54321"] },
      ],
      maxJobAgeMs: 60_000,
      now: () => first.createdAt.getTime(),
      alerts: { send: async () => undefined },
      gate: { assertClear: () => undefined },
      browserFactory: () => ({
        startLive: async () => ({} as LiveRegistrationPageDriver),
        close: async () => undefined,
      }),
      waitUntilReady: async () => "ready",
      runLive: async (options) => {
        attempted.push(options.jobId);
        if (options.jobId === first.id) throw new Error("browser unavailable");
        const claimed = store.claimSpecificJobForLiveAttempt(
          options.jobId,
          options.authorizedTargetKey,
          options.workerId,
        );
        return {
          status: "succeeded",
          job: store.completeRunningJob(claimed.id, "succeeded"),
        };
      },
      onFailure: (job) => failed.push(job.id),
    });

    worker.enqueue(first);
    worker.enqueue(second);
    await worker.drain();

    expect(attempted).toEqual([first.id, second.id]);
    expect(failed).toEqual([first.id]);
    expect(store.getJob(first.id)?.state).toBe("queued");
    expect(store.getJob(second.id)?.state).toBe("succeeded");
  });

  it("refuses blocked, non-allowlisted, duplicate, or post-stop dispatch", async () => {
    const store = await createStore();
    const queued = queue(store, "12345", "101");
    const other = queue(store, "54321", "102");
    store.claimSpecificJobForLiveAttempt(
      queued.id,
      queued.targetKey,
      "test-worker",
    );
    store.completeRunningJob(queued.id, "blocked", {
      failureCode: "manual_block",
    });
    const worker = new AutomaticRegistrationWorker({
      store,
      targetQuarter: "au26",
      allowedTargets: [{ key: "12345", slns: ["12345"] }],
      maxJobAgeMs: 60_000,
      now: () => queued.createdAt.getTime(),
      alerts: { send: async () => undefined },
      gate: { assertClear: () => undefined },
      browserFactory: () => ({
        startLive: async () => ({} as LiveRegistrationPageDriver),
        close: async () => undefined,
      }),
    });

    expect(worker.enqueue(store.getJob(queued.id)!)).toBe(false);
    expect(worker.enqueue(other)).toBe(false);
    await worker.stop();
    expect(worker.enqueue(queue(store, "67890", "103"))).toBe(false);
  });

  it("leaves stale queued jobs untouched during automatic recovery", async () => {
    const store = await createStore();
    const queued = queue(store, "12345", "101");
    const worker = new AutomaticRegistrationWorker({
      store,
      targetQuarter: "au26",
      allowedTargets: [{ key: "12345", slns: ["12345"] }],
      maxJobAgeMs: 600_000,
      now: () => queued.createdAt.getTime() + 600_001,
      alerts: { send: async () => undefined },
      gate: { assertClear: () => undefined },
      browserFactory: () => ({
        startLive: async () => ({} as LiveRegistrationPageDriver),
        close: async () => undefined,
      }),
    });

    expect(worker.enqueue(queued)).toBe(false);
    expect(store.getJob(queued.id)?.state).toBe("queued");
  });
});
