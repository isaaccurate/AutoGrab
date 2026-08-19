import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { TrustedSeatNotification } from "../notifications/notify-uw-parser.js";
import { SQLiteRegistrationJobStore } from "./sqlite-job-store.js";

const temporaryDirectories: string[] = [];
const stores: SQLiteRegistrationJobStore[] = [];
const BASE_TIME = new Date("2026-08-18T20:00:00.000Z");

function createStore(): { databasePath: string; store: SQLiteRegistrationJobStore } {
  const directory = temporaryDirectories.at(-1);
  if (!directory) throw new Error("A temporary directory has not been created.");
  const databasePath = join(directory, "private", "autograb.sqlite");
  const store = new SQLiteRegistrationJobStore(databasePath);
  stores.push(store);
  return { databasePath, store };
}

function notification(
  overrides: Partial<TrustedSeatNotification> = {},
): TrustedSeatNotification {
  return {
    sourceUidValidity: "99",
    sourceUid: "101",
    sourceMessageId: "<message-101@example.test>",
    course: "TEST 101 A",
    sln: "12345",
    receivedAt: new Date("2026-08-18T19:59:00.000Z"),
    ...overrides,
  };
}

function enqueue(
  store: SQLiteRegistrationJobStore,
  value: TrustedSeatNotification = notification(),
  now = BASE_TIME,
  targetSlns?: readonly string[],
) {
  return store.enqueueValidatedNotification({
    mailboxAccount: "student@gmail.com",
    notification: value,
    ...(targetSlns ? { targetSlns } : {}),
    now,
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SQLiteRegistrationJobStore", () => {
  it("creates a private database and records the complete initial state history", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { databasePath, store } = createStore();

    const result = enqueue(store);

    expect(result.disposition).toBe("created");
    expect(result.job).toMatchObject({
      course: "TEST 101 A",
      sln: "12345",
      targetKey: "12345",
      slns: ["12345"],
      state: "queued",
      sourceCount: 1,
    });
    expect(store.listEvents(result.job.id).map((event) => event.toState)).toEqual([
      "received",
      "validated",
      "queued",
    ]);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(databasePath))).mode & 0o777).toBe(0o700);
  });

  it("deduplicates deliveries, repeated Message-IDs, and concurrent work for an SLN", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const first = enqueue(store);

    const sameDelivery = enqueue(store);
    const copiedMessage = enqueue(
      store,
      notification({ sourceUid: "102" }),
    );
    const laterAlert = enqueue(
      store,
      notification({
        sourceUid: "103",
        sourceMessageId: "<message-103@example.test>",
      }),
    );

    expect(sameDelivery).toMatchObject({
      disposition: "duplicate_source",
      job: { id: first.job.id, sourceCount: 1 },
    });
    expect(copiedMessage).toMatchObject({
      disposition: "duplicate_source",
      job: { id: first.job.id, sourceCount: 2 },
    });
    expect(laterAlert).toMatchObject({
      disposition: "existing_target",
      job: { id: first.job.id, sourceCount: 3 },
    });
    expect(store.listEvents(first.job.id)).toHaveLength(3);
  });

  it("deduplicates notifications for either member of one registration bundle", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const first = enqueue(store, notification({ sln: "13277" }), BASE_TIME, [
      "13277",
      "13280",
    ]);
    const second = enqueue(
      store,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
        course: "TEST 101 AC",
        sln: "13280",
      }),
      new Date("2026-08-18T20:00:01.000Z"),
      ["13277", "13280"],
    );

    expect(first).toMatchObject({
      disposition: "created",
      job: {
        sln: "13277",
        targetKey: "13277+13280",
        slns: ["13277", "13280"],
      },
    });
    expect(second).toMatchObject({
      disposition: "existing_target",
      job: { id: first.job.id, sourceCount: 2 },
    });
    expect(store.listQueuedJobs()).toHaveLength(1);
  });

  it("rejects a changed Message-ID for an already-recorded IMAP delivery", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const first = enqueue(store);

    expect(() =>
      enqueue(
        store,
        notification({ sourceMessageId: "<conflict@example.test>" }),
      ),
    ).toThrow("delivery identity conflicts");
    expect(store.getJob(first.job.id)?.sourceCount).toBe(1);
  });

  it("atomically claims a queued job only once and records its outcome", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { databasePath, store } = createStore();
    const created = enqueue(store);
    const secondWorkerStore = new SQLiteRegistrationJobStore(databasePath);
    stores.push(secondWorkerStore);

    const claimed = store.claimNextJob("worker-1", {
      now: new Date("2026-08-18T20:00:01.000Z"),
      leaseMs: 60_000,
    });

    expect(claimed).toMatchObject({
      id: created.job.id,
      state: "running",
      claimedBy: "worker-1",
    });
    expect(secondWorkerStore.claimNextJob("worker-2")).toBeNull();

    const completed = store.completeRunningJob(created.job.id, "failed", {
      now: new Date("2026-08-18T20:00:02.000Z"),
      failureCode: "registration_rejected",
      detail: "  Safe detail\nwithout raw browser output.  ",
    });
    expect(completed).toMatchObject({
      state: "failed",
      claimedBy: null,
      failureCode: "registration_rejected",
      sanitizedDetail: "Safe detail without raw browser output.",
    });
    expect(store.listEvents(created.job.id).map((event) => event.toState)).toEqual([
      "received",
      "validated",
      "queued",
      "running",
      "failed",
    ]);
  });

  it("lists only queued jobs in deterministic claim order", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const first = enqueue(store);
    const second = enqueue(
      store,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
        sln: "54321",
      }),
      new Date("2026-08-18T20:01:00.000Z"),
    );

    expect(store.listQueuedJobs().map((job) => job.id)).toEqual([
      first.job.id,
      second.job.id,
    ]);
    store.claimSpecificJobForLiveAttempt(first.job.id, "12345", "worker-1");
    expect(store.listQueuedJobs().map((job) => job.id)).toEqual([second.job.id]);
  });

  it("claims only the exact live-authorized job and SLN", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const created = enqueue(store);

    expect(() =>
      store.claimSpecificJobForLiveAttempt(
        created.job.id,
        "54321",
        "live-worker",
      ),
    ).toThrow("target does not match");
    expect(store.getJob(created.job.id)?.state).toBe("queued");

    expect(
      store.claimSpecificJobForLiveAttempt(
        created.job.id,
        "12345",
        "live-worker",
      ),
    ).toMatchObject({
      id: created.job.id,
      sln: "12345",
      state: "running",
      claimedBy: "live-worker",
    });
    expect(() =>
      store.claimSpecificJobForLiveAttempt(
        created.job.id,
        "12345",
        "other-worker",
      ),
    ).toThrow("not eligible");
  });

  it("permits an explicitly matched dry-run job to advance to one live attempt", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const created = enqueue(store);
    store.claimNextJob("dry-run-worker", { now: BASE_TIME });
    store.completeRunningJob(created.job.id, "blocked", {
      now: new Date("2026-08-18T20:01:00.000Z"),
      failureCode: "dry_run_submission_disabled",
    });

    const claimed = store.claimSpecificJobForLiveAttempt(
      created.job.id,
      "12345",
      "live-worker",
      { now: new Date("2026-08-18T20:02:00.000Z") },
    );

    expect(claimed).toMatchObject({ state: "running", failureCode: null });
    expect(store.listEvents(created.job.id).map((event) => event.toState)).toEqual([
      "received",
      "validated",
      "queued",
      "running",
      "blocked",
      "running",
    ]);
  });

  it("refuses to promote jobs blocked for any reason other than a completed dry run", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const created = enqueue(store);
    store.claimNextJob("dry-run-worker", { now: BASE_TIME });
    store.completeRunningJob(created.job.id, "blocked", {
      failureCode: "sln_not_allowlisted",
    });

    expect(() =>
      store.claimSpecificJobForLiveAttempt(
        created.job.id,
        "12345",
        "live-worker",
      ),
    ).toThrow("not eligible");
  });

  it("preserves deduplication across a process restart", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { databasePath, store } = createStore();
    const created = enqueue(store);
    store.close();

    const reopened = new SQLiteRegistrationJobStore(databasePath);
    stores.push(reopened);
    const replayed = enqueue(reopened);

    expect(replayed).toMatchObject({
      disposition: "duplicate_source",
      job: { id: created.job.id, state: "queued", sourceCount: 1 },
    });
  });

  it("migrates version 1 singleton jobs into version 2 targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-jobs-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "private", "autograb.sqlite");
    await mkdir(dirname(databasePath), { recursive: true });
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        course TEXT NOT NULL,
        sln TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        cancellation_requested_at TEXT,
        failure_code TEXT,
        sanitized_detail TEXT
      );
      CREATE TABLE notification_sources (
        id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL,
        mailbox_account TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        imap_uid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        occurred_at TEXT NOT NULL,
        sanitized_detail TEXT
      );
      CREATE UNIQUE INDEX jobs_one_engaged_sln
        ON jobs(sln)
        WHERE state IN (
          'received', 'validated', 'queued', 'running',
          'succeeded', 'uncertain', 'blocked'
        );
      INSERT INTO jobs (
        id, course, sln, state, created_at, updated_at
      ) VALUES (
        'legacy-job', 'TEST 101 A', '12345', 'queued',
        '2026-08-18T20:00:00.000Z', '2026-08-18T20:00:00.000Z'
      );
      INSERT INTO notification_sources (
        job_id, mailbox_account, uid_validity, imap_uid,
        message_id, received_at, recorded_at
      ) VALUES (
        'legacy-job', 'student@gmail.com', '99', '101',
        '<legacy@example.test>', '2026-08-18T19:59:00.000Z',
        '2026-08-18T20:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const store = new SQLiteRegistrationJobStore(databasePath);
    stores.push(store);

    expect(store.getJob("legacy-job")).toMatchObject({
      sln: "12345",
      targetKey: "12345",
      slns: ["12345"],
      state: "queued",
    });
  });

  it("keeps a succeeded target closed but permits fresh work after failed or cancelled jobs", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const failed = enqueue(store);
    store.claimNextJob("worker-1", { now: BASE_TIME });
    store.completeRunningJob(failed.job.id, "failed", {
      now: new Date("2026-08-18T20:01:00.000Z"),
      failureCode: "seat_closed",
    });

    const retryFromNewAlert = enqueue(
      store,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
      }),
      new Date("2026-08-18T20:02:00.000Z"),
    );
    expect(retryFromNewAlert.disposition).toBe("created");
    expect(retryFromNewAlert.job.id).not.toBe(failed.job.id);

    store.claimNextJob("worker-2", {
      now: new Date("2026-08-18T20:03:00.000Z"),
    });
    store.completeRunningJob(retryFromNewAlert.job.id, "succeeded", {
      now: new Date("2026-08-18T20:04:00.000Z"),
    });
    const afterSuccess = enqueue(
      store,
      notification({
        sourceUid: "103",
        sourceMessageId: "<message-103@example.test>",
      }),
      new Date("2026-08-18T20:05:00.000Z"),
    );
    expect(afterSuccess).toMatchObject({
      disposition: "existing_target",
      job: { id: retryFromNewAlert.job.id, state: "succeeded", sourceCount: 2 },
    });

    const cancelledTarget = enqueue(
      store,
      notification({
        sourceUid: "104",
        sourceMessageId: "<message-104@example.test>",
        sln: "54321",
      }),
      new Date("2026-08-18T20:06:00.000Z"),
    );
    store.cancelJob(cancelledTarget.job.id, new Date("2026-08-18T20:07:00.000Z"));
    const afterCancellation = enqueue(
      store,
      notification({
        sourceUid: "105",
        sourceMessageId: "<message-105@example.test>",
        sln: "54321",
      }),
      new Date("2026-08-18T20:08:00.000Z"),
    );
    expect(afterCancellation).toMatchObject({
      disposition: "created",
      job: { state: "queued", targetKey: "54321" },
    });
    expect(afterCancellation.job.id).not.toBe(cancelledTarget.job.id);
  });

  it("permits a fresh notification after a retryable pre-submission block", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const blocked = enqueue(store);
    store.claimNextJob("worker-1", { now: BASE_TIME });
    store.completeRunningJob(blocked.job.id, "blocked", {
      now: new Date("2026-08-18T20:01:00.000Z"),
      failureCode: "pre_submission_stopped",
    });

    const fresh = enqueue(
      store,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
      }),
      new Date("2026-08-18T20:02:00.000Z"),
    );

    expect(fresh).toMatchObject({
      disposition: "created",
      job: { state: "queued", targetKey: "12345", sourceCount: 1 },
    });
    expect(fresh.job.id).not.toBe(blocked.job.id);
    expect(store.getJob(blocked.job.id)).toMatchObject({
      state: "blocked",
      sourceCount: 1,
      failureCode: "pre_submission_stopped",
    });
  });

  it("keeps a non-retryable blocked target closed", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const blocked = enqueue(store);
    store.claimNextJob("worker-1", { now: BASE_TIME });
    store.completeRunningJob(blocked.job.id, "blocked", {
      now: new Date("2026-08-18T20:01:00.000Z"),
      failureCode: "cart_verification_failed",
    });

    const laterAlert = enqueue(
      store,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
      }),
      new Date("2026-08-18T20:02:00.000Z"),
    );

    expect(laterAlert).toMatchObject({
      disposition: "existing_target",
      job: {
        id: blocked.job.id,
        state: "blocked",
        sourceCount: 2,
        failureCode: "cart_verification_failed",
      },
    });
  });

  it("migrates the engaged-target index so retryable version 2 blocks no longer suppress fresh work", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { databasePath, store } = createStore();
    const blocked = enqueue(store);
    store.claimNextJob("worker-1", { now: BASE_TIME });
    store.completeRunningJob(blocked.job.id, "blocked", {
      now: new Date("2026-08-18T20:01:00.000Z"),
      failureCode: "pre_submission_stopped",
    });
    store.close();

    const versionTwo = new Database(databasePath);
    versionTwo.exec(`
      DROP INDEX jobs_one_engaged_target;
      CREATE UNIQUE INDEX jobs_one_engaged_target
        ON jobs(target_key)
        WHERE state IN (
          'received', 'validated', 'queued', 'running',
          'succeeded', 'uncertain', 'blocked'
        );
      PRAGMA user_version = 2;
    `);
    versionTwo.close();

    const migrated = new SQLiteRegistrationJobStore(databasePath);
    stores.push(migrated);
    const fresh = enqueue(
      migrated,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
      }),
      new Date("2026-08-18T20:02:00.000Z"),
    );

    expect(fresh).toMatchObject({
      disposition: "created",
      job: { state: "queued", targetKey: "12345" },
    });
    const migratedDatabase = new Database(databasePath, { readonly: true });
    expect(migratedDatabase.pragma("user_version", { simple: true })).toBe(3);
    migratedDatabase.close();
  });

  it("cancels queued work and persists a cancellation request for running work", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const queued = enqueue(store);

    expect(store.cancelJob(queued.job.id, BASE_TIME)).toMatchObject({
      disposition: "cancelled",
      job: { state: "cancelled" },
    });
    expect(store.claimNextJob("worker-1")).toBeNull();

    const second = enqueue(
      store,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
      }),
      new Date("2026-08-18T20:01:00.000Z"),
    );
    store.claimNextJob("worker-1", {
      now: new Date("2026-08-18T20:02:00.000Z"),
    });
    const requested = store.cancelJob(
      second.job.id,
      new Date("2026-08-18T20:03:00.000Z"),
    );
    expect(requested).toMatchObject({
      disposition: "requested",
      job: { state: "running" },
    });
    expect(requested.job.cancellationRequestedAt).not.toBeNull();
    expect(store.listEvents(second.job.id).at(-1)).toMatchObject({
      kind: "cancellation_requested",
      fromState: "running",
      toState: "running",
    });
  });

  it("moves an expired running lease to uncertain instead of retrying it", async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), "autograb-jobs-")));
    const { store } = createStore();
    const created = enqueue(store);
    store.claimNextJob("worker-1", { now: BASE_TIME, leaseMs: 1_000 });

    expect(
      store.recoverExpiredRunningJobs(
        new Date("2026-08-18T20:00:00.999Z"),
      ),
    ).toBe(0);
    expect(
      store.recoverExpiredRunningJobs(
        new Date("2026-08-18T20:00:01.000Z"),
      ),
    ).toBe(1);
    expect(store.getJob(created.job.id)).toMatchObject({
      state: "uncertain",
      failureCode: "worker_lease_expired",
    });
    expect(store.claimNextJob("worker-2")).toBeNull();

    const laterAlert = enqueue(
      store,
      notification({
        sourceUid: "102",
        sourceMessageId: "<message-102@example.test>",
      }),
      new Date("2026-08-18T20:01:00.000Z"),
    );
    expect(laterAlert).toMatchObject({
      disposition: "existing_target",
      job: { id: created.job.id, state: "uncertain", sourceCount: 2 },
    });
  });

  it("rejects a symbolic-link database target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-jobs-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.sqlite");
    const targetStore = new SQLiteRegistrationJobStore(target);
    targetStore.close();
    const link = join(directory, "linked.sqlite");
    await symlink(target, link);

    expect(() => new SQLiteRegistrationJobStore(link)).toThrow(
      "database path is not a regular file",
    );
  });
});
