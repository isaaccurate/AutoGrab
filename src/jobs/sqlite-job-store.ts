import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import type { TrustedSeatNotification } from "../notifications/notify-uw-parser.js";
import {
  normalizeRegistrationTargets,
  type RegistrationTarget,
} from "../registration/registration-target.js";

const SCHEMA_VERSION = 3;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const IMAP_IDENTIFIER_PATTERN = /^(?:0|[1-9]\d*)$/;
const SLN_PATTERN = /^\d{5}$/;
const WORKER_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/;
const FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,100}$/;
const MAX_IMAP_IDENTIFIER = 4_294_967_295n;
const MAX_DETAIL_LENGTH = 500;

export const RETRYABLE_BLOCKED_FAILURE_CODES = [
  "pre_submission_stopped",
] as const;

const retryableBlockedFailureCodesSql = RETRYABLE_BLOCKED_FAILURE_CODES.map(
  (failureCode) => `'${failureCode}'`,
).join(", ");

const engagedTargetPredicate = `
  state IN (
    'received', 'validated', 'queued', 'running',
    'succeeded', 'uncertain'
  )
  OR (
    state = 'blocked'
    AND (
      failure_code IS NULL
      OR failure_code NOT IN (${retryableBlockedFailureCodesSql})
    )
  )
`;

export const JOB_STATES = [
  "received",
  "validated",
  "queued",
  "running",
  "succeeded",
  "failed",
  "uncertain",
  "blocked",
  "cancelled",
] as const;

export type RegistrationJobState = (typeof JOB_STATES)[number];
export type RunningJobOutcome =
  | "succeeded"
  | "failed"
  | "uncertain"
  | "blocked";

export interface RegistrationJob {
  readonly id: string;
  readonly course: string;
  readonly sln: string;
  readonly targetKey: string;
  readonly slns: readonly string[];
  readonly state: RegistrationJobState;
  readonly sourceCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly cancellationRequestedAt: Date | null;
  readonly failureCode: string | null;
  readonly sanitizedDetail: string | null;
}

export interface JobEvent {
  readonly id: number;
  readonly jobId: string;
  readonly kind: "transition" | "cancellation_requested";
  readonly fromState: RegistrationJobState | null;
  readonly toState: RegistrationJobState | null;
  readonly occurredAt: Date;
  readonly sanitizedDetail: string | null;
}

export interface EnqueueValidatedNotificationInput {
  readonly mailboxAccount: string;
  readonly notification: TrustedSeatNotification;
  readonly targetSlns?: readonly string[];
  readonly now?: Date;
}

export interface EnqueueValidatedNotificationResult {
  readonly disposition: "created" | "duplicate_source" | "existing_target";
  readonly job: RegistrationJob;
}

export interface CancellationResult {
  readonly disposition: "cancelled" | "requested" | "unchanged";
  readonly job: RegistrationJob;
}

interface JobRow {
  id: string;
  course: string;
  sln: string;
  target_key: string;
  target_slns: string;
  state: RegistrationJobState;
  source_count: number;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  cancellation_requested_at: string | null;
  failure_code: string | null;
  sanitized_detail: string | null;
}

interface SourceRow {
  id: number;
  job_id: string;
  message_id: string;
}

interface EventRow {
  id: number;
  job_id: string;
  kind: JobEvent["kind"];
  from_state: RegistrationJobState | null;
  to_state: RegistrationJobState | null;
  occurred_at: string;
  sanitized_detail: string | null;
}

const JOB_SELECT = `
  SELECT
    jobs.*,
    (SELECT COUNT(*) FROM notification_sources WHERE job_id = jobs.id) AS source_count
  FROM jobs
`;

export function defaultJobDatabasePath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "AutoGrab",
    "autograb.sqlite",
  );
}

function checkedDate(value: Date, label: string): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return value.toISOString();
}

function nullableDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function sanitizeDetail(value: string | undefined): string | null {
  if (value === undefined) return null;
  const sanitized = value.replace(/[\r\n\t]+/g, " ").trim();
  return sanitized ? sanitized.slice(0, MAX_DETAIL_LENGTH) : null;
}

function assertImapIdentifier(value: string, label: string, allowZero: boolean): void {
  if (
    !IMAP_IDENTIFIER_PATTERN.test(value) ||
    (!allowZero && value === "0") ||
    BigInt(value) > MAX_IMAP_IDENTIFIER
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertInput(input: EnqueueValidatedNotificationInput): void {
  const { mailboxAccount, notification } = input;
  if (!mailboxAccount.trim() || mailboxAccount !== mailboxAccount.toLowerCase()) {
    throw new Error("The mailbox account must be normalized.");
  }
  if (!notification.sourceMessageId.trim()) {
    throw new Error("The source Message-ID is required.");
  }
  if (!notification.course.trim()) {
    throw new Error("The course is required.");
  }
  if (!SLN_PATTERN.test(notification.sln)) {
    throw new Error("The SLN must contain exactly five digits.");
  }
  const target = targetForInput(input);
  if (!target.slns.includes(notification.sln)) {
    throw new Error("The notified SLN must belong to the registration target.");
  }
  assertImapIdentifier(notification.sourceUidValidity, "UIDVALIDITY", false);
  assertImapIdentifier(notification.sourceUid, "The IMAP UID", false);
  checkedDate(notification.receivedAt, "The notification arrival time");
}

function targetForInput(input: EnqueueValidatedNotificationInput): RegistrationTarget {
  const target = normalizeRegistrationTargets([
    input.targetSlns ?? [input.notification.sln],
  ])[0];
  if (!target) throw new Error("The registration target is required.");
  return target;
}

function ensurePrivateDatabaseLocation(databasePath: string): void {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("The AutoGrab state directory is not a regular directory.");
  }
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);

  if (!existsSync(databasePath)) return;
  const databaseMetadata = lstatSync(databasePath);
  if (!databaseMetadata.isFile() || databaseMetadata.isSymbolicLink()) {
    throw new Error("The AutoGrab database path is not a regular file.");
  }
  chmodSync(databasePath, PRIVATE_FILE_MODE);
}

function initializeDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 1000");

  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error("The AutoGrab database schema is newer than this application.");
  }

  if (version === 0) {
    database.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        course TEXT NOT NULL,
        sln TEXT NOT NULL CHECK(length(sln) = 5 AND sln NOT GLOB '*[^0-9]*'),
        target_key TEXT NOT NULL,
        target_slns TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'received', 'validated', 'queued', 'running', 'succeeded',
          'failed', 'uncertain', 'blocked', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        cancellation_requested_at TEXT,
        failure_code TEXT,
        sanitized_detail TEXT,
        CHECK(
          (state = 'running' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL) OR
          (state != 'running' AND claimed_by IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
        )
      ) STRICT;

      CREATE TABLE notification_sources (
        id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        mailbox_account TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        imap_uid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(mailbox_account, uid_validity, imap_uid)
      ) STRICT;

      CREATE INDEX notification_sources_message_id
        ON notification_sources(message_id);

      CREATE UNIQUE INDEX jobs_one_engaged_target
        ON jobs(target_key)
        WHERE ${engagedTargetPredicate};

      CREATE INDEX jobs_queue_order
        ON jobs(state, cancellation_requested_at, created_at);

      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        kind TEXT NOT NULL CHECK(kind IN ('transition', 'cancellation_requested')),
        from_state TEXT,
        to_state TEXT,
        occurred_at TEXT NOT NULL,
        sanitized_detail TEXT,
        CHECK(
          (kind = 'transition' AND to_state IS NOT NULL) OR
          (kind = 'cancellation_requested' AND from_state = to_state)
        )
      ) STRICT;

      CREATE INDEX job_events_job_order ON job_events(job_id, id);

      CREATE TRIGGER job_events_no_update
      BEFORE UPDATE ON job_events
      BEGIN
        SELECT RAISE(ABORT, 'job events are immutable');
      END;

      CREATE TRIGGER job_events_no_delete
      BEFORE DELETE ON job_events
      BEGIN
        SELECT RAISE(ABORT, 'job events are immutable');
      END;

      PRAGMA user_version = 3;
      COMMIT;
    `);
  } else if (version === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE jobs ADD COLUMN target_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE jobs ADD COLUMN target_slns TEXT NOT NULL DEFAULT '[]';
      UPDATE jobs
      SET target_key = sln,
          target_slns = '["' || sln || '"]';
      DROP INDEX jobs_one_engaged_sln;
      CREATE UNIQUE INDEX jobs_one_engaged_target
        ON jobs(target_key)
        WHERE state IN (
          'received', 'validated', 'queued', 'running',
          'succeeded', 'uncertain', 'blocked'
        );
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }

  if (version === 1 || version === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX jobs_one_engaged_target;
      CREATE UNIQUE INDEX jobs_one_engaged_target
        ON jobs(target_key)
        WHERE ${engagedTargetPredicate};
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }

  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("trusted_schema = OFF");
}

function mapJob(row: JobRow): RegistrationJob {
  const target = normalizeRegistrationTargets([
    JSON.parse(row.target_slns) as readonly string[],
  ])[0];
  if (!target || target.key !== row.target_key || !target.slns.includes(row.sln)) {
    throw new Error("The stored registration target is invalid.");
  }
  return {
    id: row.id,
    course: row.course,
    sln: row.sln,
    targetKey: target.key,
    slns: target.slns,
    state: row.state,
    sourceCount: row.source_count,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    claimedBy: row.claimed_by,
    claimedAt: nullableDate(row.claimed_at),
    leaseExpiresAt: nullableDate(row.lease_expires_at),
    cancellationRequestedAt: nullableDate(row.cancellation_requested_at),
    failureCode: row.failure_code,
    sanitizedDetail: row.sanitized_detail,
  };
}

export class SQLiteRegistrationJobStore {
  private closed = false;

  constructor(
    private readonly databasePath = defaultJobDatabasePath(),
    private readonly database = SQLiteRegistrationJobStore.openDatabase(databasePath),
  ) {}

  private static openDatabase(databasePath: string): Database.Database {
    ensurePrivateDatabaseLocation(databasePath);
    const database = new Database(databasePath);
    try {
      initializeDatabase(database);
      chmodSync(databasePath, PRIVATE_FILE_MODE);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  enqueueValidatedNotification(
    input: EnqueueValidatedNotificationInput,
  ): EnqueueValidatedNotificationResult {
    this.assertOpen();
    assertInput(input);
    const target = targetForInput(input);
    const now = checkedDate(input.now ?? new Date(), "The enqueue time");
    const receivedAt = checkedDate(
      input.notification.receivedAt,
      "The notification arrival time",
    );

    const enqueue = this.database.transaction(() => {
      const existingDelivery = this.database
        .prepare(`
          SELECT id, job_id, message_id
          FROM notification_sources
          WHERE mailbox_account = ? AND uid_validity = ? AND imap_uid = ?
        `)
        .get(
          input.mailboxAccount,
          input.notification.sourceUidValidity,
          input.notification.sourceUid,
        ) as SourceRow | undefined;

      if (existingDelivery) {
        if (existingDelivery.message_id !== input.notification.sourceMessageId) {
          throw new Error("The IMAP delivery identity conflicts with stored state.");
        }
        return {
          disposition: "duplicate_source" as const,
          jobId: existingDelivery.job_id,
        };
      }

      const sameMessage = this.database
        .prepare(`
          SELECT id, job_id, message_id
          FROM notification_sources
          WHERE message_id = ?
          ORDER BY id
          LIMIT 1
        `)
        .get(input.notification.sourceMessageId) as SourceRow | undefined;

      const engagedJob = sameMessage
        ? undefined
        : (this.database
            .prepare(`
              SELECT id
              FROM jobs
              WHERE target_key = ?
                AND (${engagedTargetPredicate})
              LIMIT 1
            `)
            .get(target.key) as { id: string } | undefined);

      const existingJobId = sameMessage?.job_id ?? engagedJob?.id;
      if (existingJobId) {
        this.insertSource(input, existingJobId, receivedAt, now);
        return {
          disposition: sameMessage
            ? ("duplicate_source" as const)
            : ("existing_target" as const),
          jobId: existingJobId,
        };
      }

      const jobId = randomUUID();
      this.database
        .prepare(`
          INSERT INTO jobs (
            id, course, sln, target_key, target_slns,
            state, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
        `)
        .run(
          jobId,
          input.notification.course,
          input.notification.sln,
          target.key,
          JSON.stringify(target.slns),
          now,
          now,
        );
      this.insertSource(input, jobId, receivedAt, now);
      this.insertTransition(jobId, null, "received", now, null);
      this.insertTransition(jobId, "received", "validated", now, null);
      this.insertTransition(jobId, "validated", "queued", now, null);
      return { disposition: "created" as const, jobId };
    });

    const result = enqueue.immediate();
    return {
      disposition: result.disposition,
      job: this.requireJob(result.jobId),
    };
  }

  claimNextJob(
    workerId: string,
    options: { now?: Date; leaseMs?: number } = {},
  ): RegistrationJob | null {
    this.assertOpen();
    if (!WORKER_ID_PATTERN.test(workerId)) {
      throw new Error("The worker ID is invalid.");
    }
    const leaseMs = options.leaseMs ?? 2 * 60 * 1_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("The worker lease must be a positive integer.");
    }
    const nowDate = options.now ?? new Date();
    const now = checkedDate(nowDate, "The claim time");
    const leaseExpiresAt = checkedDate(
      new Date(nowDate.getTime() + leaseMs),
      "The lease expiration time",
    );

    const claim = this.database.transaction(() => {
      const claimed = this.database
        .prepare(`
          UPDATE jobs
          SET state = 'running',
              updated_at = ?,
              claimed_by = ?,
              claimed_at = ?,
              lease_expires_at = ?
          WHERE id = (
            SELECT id
            FROM jobs
            WHERE state = 'queued' AND cancellation_requested_at IS NULL
            ORDER BY created_at, id
            LIMIT 1
          )
            AND state = 'queued'
          RETURNING id
        `)
        .get(now, workerId, now, leaseExpiresAt) as { id: string } | undefined;
      if (!claimed) return null;
      this.insertTransition(claimed.id, "queued", "running", now, null);
      return claimed.id;
    });

    const jobId = claim.immediate();
    return jobId === null ? null : this.requireJob(jobId);
  }

  claimSpecificJobForLiveAttempt(
    jobId: string,
    expectedTargetKey: string,
    workerId: string,
    options: { now?: Date; leaseMs?: number } = {},
  ): RegistrationJob {
    this.assertOpen();
    if (!jobId) throw new Error("The job ID is required.");
    if (!expectedTargetKey) {
      throw new Error("The expected registration target is required.");
    }
    if (!WORKER_ID_PATTERN.test(workerId)) {
      throw new Error("The worker ID is invalid.");
    }
    const leaseMs = options.leaseMs ?? 2 * 60 * 1_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("The worker lease must be a positive integer.");
    }
    const nowDate = options.now ?? new Date();
    const now = checkedDate(nowDate, "The claim time");
    const leaseExpiresAt = checkedDate(
      new Date(nowDate.getTime() + leaseMs),
      "The lease expiration time",
    );

    const claim = this.database.transaction(() => {
      const current = this.database
        .prepare(`
          SELECT state, target_key, failure_code, cancellation_requested_at
          FROM jobs
          WHERE id = ?
        `)
        .get(jobId) as
        | {
            state: RegistrationJobState;
            target_key: string;
            failure_code: string | null;
            cancellation_requested_at: string | null;
          }
        | undefined;
      if (!current) throw new Error("The registration job was not found.");
      if (current.target_key !== expectedTargetKey) {
        throw new Error("The live authorization target does not match the job.");
      }
      if (current.cancellation_requested_at !== null) {
        throw new Error("The registration job has a cancellation request.");
      }
      const isFreshQueue = current.state === "queued";
      const isCompletedDryRun =
        current.state === "blocked" &&
        current.failure_code === "dry_run_submission_disabled";
      if (!isFreshQueue && !isCompletedDryRun) {
        throw new Error("The registration job is not eligible for a live attempt.");
      }

      const result = this.database
        .prepare(`
          UPDATE jobs
          SET state = 'running',
              updated_at = ?,
              claimed_by = ?,
              claimed_at = ?,
              lease_expires_at = ?,
              failure_code = NULL,
              sanitized_detail = NULL
          WHERE id = ? AND state = ?
        `)
        .run(
          now,
          workerId,
          now,
          leaseExpiresAt,
          jobId,
          current.state,
        );
      if (result.changes !== 1) {
        throw new Error("The registration job changed before live claiming.");
      }
      this.insertTransition(jobId, current.state, "running", now, null);
    });

    claim.immediate();
    return this.requireJob(jobId);
  }

  completeRunningJob(
    jobId: string,
    outcome: RunningJobOutcome,
    options: { now?: Date; failureCode?: string; detail?: string } = {},
  ): RegistrationJob {
    this.assertOpen();
    if (!jobId) throw new Error("The job ID is required.");
    if (options.failureCode && !FAILURE_CODE_PATTERN.test(options.failureCode)) {
      throw new Error("The failure code is invalid.");
    }
    if (outcome === "succeeded" && options.failureCode) {
      throw new Error("A successful job cannot have a failure code.");
    }
    const now = checkedDate(options.now ?? new Date(), "The completion time");
    const detail = sanitizeDetail(options.detail);

    const complete = this.database.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE jobs
          SET state = ?,
              updated_at = ?,
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              failure_code = ?,
              sanitized_detail = ?
          WHERE id = ? AND state = 'running'
        `)
        .run(outcome, now, options.failureCode ?? null, detail, jobId);
      if (result.changes !== 1) {
        throw new Error("Only a running job can be completed.");
      }
      this.insertTransition(jobId, "running", outcome, now, detail);
    });
    complete.immediate();
    return this.requireJob(jobId);
  }

  cancelJob(jobId: string, nowDate = new Date()): CancellationResult {
    this.assertOpen();
    const now = checkedDate(nowDate, "The cancellation time");
    const cancel = this.database.transaction(() => {
      const current = this.database
        .prepare("SELECT state, cancellation_requested_at FROM jobs WHERE id = ?")
        .get(jobId) as
        | { state: RegistrationJobState; cancellation_requested_at: string | null }
        | undefined;
      if (!current) throw new Error("The registration job was not found.");

      if (current.state === "running") {
        if (current.cancellation_requested_at !== null) {
          return "unchanged" as const;
        }
        this.database
          .prepare(`
            UPDATE jobs
            SET cancellation_requested_at = ?, updated_at = ?
            WHERE id = ? AND state = 'running'
          `)
          .run(now, now, jobId);
        this.insertEvent(
          jobId,
          "cancellation_requested",
          "running",
          "running",
          now,
          null,
        );
        return "requested" as const;
      }

      if (["received", "validated", "queued"].includes(current.state)) {
        this.database
          .prepare(`
            UPDATE jobs
            SET state = 'cancelled',
                updated_at = ?,
                cancellation_requested_at = ?
            WHERE id = ? AND state = ?
          `)
          .run(now, now, jobId, current.state);
        this.insertTransition(jobId, current.state, "cancelled", now, null);
        return "cancelled" as const;
      }

      return "unchanged" as const;
    });

    const disposition = cancel.immediate();
    return { disposition, job: this.requireJob(jobId) };
  }

  recoverExpiredRunningJobs(nowDate = new Date()): number {
    this.assertOpen();
    const now = checkedDate(nowDate, "The recovery time");
    const recover = this.database.transaction(() => {
      const expired = this.database
        .prepare(`
          SELECT id
          FROM jobs
          WHERE state = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          ORDER BY id
        `)
        .all(now) as Array<{ id: string }>;

      for (const { id } of expired) {
        this.database
          .prepare(`
            UPDATE jobs
            SET state = 'uncertain',
                updated_at = ?,
                claimed_by = NULL,
                claimed_at = NULL,
                lease_expires_at = NULL,
                failure_code = 'worker_lease_expired',
                sanitized_detail = 'Worker stopped before recording a definitive result.'
            WHERE id = ? AND state = 'running'
          `)
          .run(now, id);
        this.insertTransition(
          id,
          "running",
          "uncertain",
          now,
          "Worker stopped before recording a definitive result.",
        );
      }
      return expired.length;
    });
    return recover.immediate();
  }

  getJob(jobId: string): RegistrationJob | null {
    this.assertOpen();
    const row = this.database
      .prepare(`${JOB_SELECT} WHERE jobs.id = ?`)
      .get(jobId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  listQueuedJobs(): readonly RegistrationJob[] {
    this.assertOpen();
    const rows = this.database
      .prepare(`
        ${JOB_SELECT}
        WHERE jobs.state = 'queued'
          AND jobs.cancellation_requested_at IS NULL
        ORDER BY jobs.created_at, jobs.id
      `)
      .all() as JobRow[];
    return rows.map(mapJob);
  }

  listEvents(jobId: string): readonly JobEvent[] {
    this.assertOpen();
    const rows = this.database
      .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id")
      .all(jobId) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      kind: row.kind,
      fromState: row.from_state,
      toState: row.to_state,
      occurredAt: new Date(row.occurred_at),
      sanitizedDetail: row.sanitized_detail,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    this.database.close();
    this.closed = true;
  }

  private insertSource(
    input: EnqueueValidatedNotificationInput,
    jobId: string,
    receivedAt: string,
    recordedAt: string,
  ): void {
    this.database
      .prepare(`
        INSERT INTO notification_sources (
          job_id, mailbox_account, uid_validity, imap_uid,
          message_id, received_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        jobId,
        input.mailboxAccount,
        input.notification.sourceUidValidity,
        input.notification.sourceUid,
        input.notification.sourceMessageId,
        receivedAt,
        recordedAt,
      );
  }

  private insertTransition(
    jobId: string,
    fromState: RegistrationJobState | null,
    toState: RegistrationJobState,
    occurredAt: string,
    detail: string | null,
  ): void {
    this.insertEvent(
      jobId,
      "transition",
      fromState,
      toState,
      occurredAt,
      detail,
    );
  }

  private insertEvent(
    jobId: string,
    kind: JobEvent["kind"],
    fromState: RegistrationJobState | null,
    toState: RegistrationJobState | null,
    occurredAt: string,
    detail: string | null,
  ): void {
    this.database
      .prepare(`
        INSERT INTO job_events (
          job_id, kind, from_state, to_state, occurred_at, sanitized_detail
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(jobId, kind, fromState, toState, occurredAt, detail);
  }

  private requireJob(jobId: string): RegistrationJob {
    const job = this.getJob(jobId);
    if (!job) throw new Error("The registration job was not found.");
    return job;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The registration job store is closed.");
  }
}
