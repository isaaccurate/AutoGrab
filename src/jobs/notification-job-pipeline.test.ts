import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CandidateEmail } from "../email/types.js";
import { parseNotifyUwNotification } from "../notifications/notify-uw-parser.js";
import { SQLiteRegistrationJobStore } from "./sqlite-job-store.js";

describe("trusted notification to durable job pipeline", () => {
  it("turns repeated valid email deliveries into one queued job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-pipeline-"));
    const store = new SQLiteRegistrationJobStore(
      join(directory, "state", "autograb.sqlite"),
    );

    try {
      const rawSource = await readFile(
        "test/fixtures/notify-uw-seat-available.eml",
      );
      const candidate: CandidateEmail = {
        uidValidity: "99",
        uid: "101",
        messageId:
          "<test-notify-uw-seat-available@us-west-2.amazonses.com>",
        from: ["notify-noreply@uw.edu"],
        subject: "Notify.UW: TEST 101 A has seats available",
        receivedAt: new Date("2026-08-18T19:20:44.000Z"),
        size: rawSource.byteLength,
        rawSource,
      };
      const parserOptions = {
        expectedRecipient: "student@gmail.com",
        allowedSlns: ["12345"],
        maxAgeMs: 10 * 60 * 1_000,
        now: new Date("2026-08-18T19:21:44.000Z"),
      };

      const first = await parseNotifyUwNotification(candidate, parserOptions);
      expect(first.accepted).toBe(true);
      if (!first.accepted) return;
      const created = store.enqueueValidatedNotification({
        mailboxAccount: "student@gmail.com",
        notification: first.notification,
        now: parserOptions.now,
      });

      const duplicate = await parseNotifyUwNotification(
        { ...candidate, uid: "102" },
        parserOptions,
      );
      expect(duplicate.accepted).toBe(true);
      if (!duplicate.accepted) return;
      const deduplicated = store.enqueueValidatedNotification({
        mailboxAccount: "student@gmail.com",
        notification: duplicate.notification,
        now: parserOptions.now,
      });

      expect(created).toMatchObject({
        disposition: "created",
        job: { state: "queued", sln: "12345", sourceCount: 1 },
      });
      expect(deduplicated).toMatchObject({
        disposition: "duplicate_source",
        job: { id: created.job.id, sourceCount: 2 },
      });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
