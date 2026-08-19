import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import type { CandidateEmail } from "../email/types.js";
import {
  parseNotifyUwNotification,
  type NotifyUwParserOptions,
} from "./notify-uw-parser.js";

const FIXTURE_PATH = "test/fixtures/notify-uw-seat-available.eml";
const RECEIVED_AT = new Date("2026-08-18T19:20:44.000Z");
const MESSAGE_ID =
  "<test-notify-uw-seat-available@us-west-2.amazonses.com>";

let fixture: Buffer;

beforeAll(async () => {
  fixture = await readFile(FIXTURE_PATH);
});

function createCandidate(
  rawSource: Buffer | null = fixture,
  overrides: Partial<CandidateEmail> = {},
): CandidateEmail {
  return {
    uidValidity: "99",
    uid: "101",
    messageId: MESSAGE_ID,
    from: ["notify-noreply@uw.edu"],
    subject: "Notify.UW: TEST 101 A has seats available",
    receivedAt: RECEIVED_AT,
    size: rawSource?.byteLength ?? null,
    rawSource,
    ...overrides,
  };
}

function createOptions(
  overrides: Partial<NotifyUwParserOptions> = {},
): NotifyUwParserOptions {
  return {
    expectedRecipient: "student@gmail.com",
    allowedSlns: ["12345"],
    maxAgeMs: 10 * 60 * 1_000,
    now: new Date("2026-08-18T19:21:44.000Z"),
    ...overrides,
  };
}

function changedFixture(search: string, replacement: string): Buffer {
  const source = fixture.toString("utf8");
  expect(source).toContain(search);
  return Buffer.from(source.replace(search, replacement));
}

describe("parseNotifyUwNotification", () => {
  it("accepts the sanitized real Notify.UW fixture", async () => {
    await expect(
      parseNotifyUwNotification(createCandidate(), createOptions()),
    ).resolves.toEqual({
      accepted: true,
      notification: {
        sourceUidValidity: "99",
        sourceUid: "101",
        sourceMessageId: MESSAGE_ID,
        course: "TEST 101 A",
        sln: "12345",
        receivedAt: RECEIVED_AT,
      },
    });
  });

  it("is deterministic for duplicate copies without performing deduplication", async () => {
    const first = await parseNotifyUwNotification(
      createCandidate(),
      createOptions(),
    );
    const duplicate = await parseNotifyUwNotification(
      createCandidate(),
      createOptions(),
    );

    expect(duplicate).toEqual(first);
  });

  it.each([
    [
      "sender_mismatch",
      'From: "Notify.UW" <notify-noreply@uw.edu>',
      'From: "Notify.UW" <attacker@example.com>',
    ],
    [
      "recipient_mismatch",
      "To: student@gmail.com",
      "To: someone-else@gmail.com",
    ],
    [
      "authentication_failed",
      "Authentication-Results: mx.google.com;",
      "Authentication-Results: untrusted.example;",
    ],
    [
      "authentication_failed",
      "dmarc=pass header.from=uw.edu",
      "dmarc=fail header.from=uw.edu",
    ],
    [
      "structure_mismatch",
      'href="https://register.uw.edu"',
      'href="https://register.uw.edu/attempt?unsafe=true"',
    ],
    [
      "structure_mismatch",
      "TEST 101 A (SLN: 12345)",
      "TEST 102 A (SLN: 12345)",
    ],
  ] as const)(
    "rejects %s fixture mutation",
    async (reason, search, replacement) => {
      const raw = changedFixture(search, replacement);
      await expect(
        parseNotifyUwNotification(createCandidate(raw), createOptions()),
      ).resolves.toEqual({ accepted: false, reason });
    },
  );

  it("rejects disagreement between the envelope and raw Message-ID", async () => {
    await expect(
      parseNotifyUwNotification(
        createCandidate(fixture, { messageId: "<different@example.test>" }),
        createOptions(),
      ),
    ).resolves.toEqual({
      accepted: false,
      reason: "message_id_mismatch",
    });
  });

  it("rejects a later forged pass when Gmail's first result failed", async () => {
    const raw = changedFixture(
      "Authentication-Results: mx.google.com;",
      "Authentication-Results: mx.google.com; dkim=fail header.i=@uw.edu; spf=fail; dmarc=fail header.from=uw.edu\r\n" +
        "Authentication-Results: mx.google.com;",
    );

    await expect(
      parseNotifyUwNotification(createCandidate(raw), createOptions()),
    ).resolves.toEqual({
      accepted: false,
      reason: "authentication_failed",
    });
  });

  it("rejects subject disagreement and malformed subject structure", async () => {
    await expect(
      parseNotifyUwNotification(
        createCandidate(fixture, { subject: "Unexpected subject" }),
        createOptions(),
      ),
    ).resolves.toEqual({ accepted: false, reason: "subject_mismatch" });

    const raw = changedFixture(
      "Subject: Notify.UW: TEST 101 A has seats available",
      "Subject: TEST 101 A has seats available",
    );
    await expect(
      parseNotifyUwNotification(
        createCandidate(raw, { subject: "TEST 101 A has seats available" }),
        createOptions(),
      ),
    ).resolves.toEqual({ accepted: false, reason: "subject_mismatch" });
  });

  it("rejects stale and future-dated mailbox arrivals", async () => {
    await expect(
      parseNotifyUwNotification(
        createCandidate(),
        createOptions({ now: new Date("2026-08-18T19:31:45.000Z") }),
      ),
    ).resolves.toEqual({ accepted: false, reason: "stale_notification" });

    await expect(
      parseNotifyUwNotification(
        createCandidate(fixture, {
          receivedAt: new Date("2026-08-18T19:25:00.000Z"),
        }),
        createOptions(),
      ),
    ).resolves.toEqual({ accepted: false, reason: "invalid_timestamp" });
  });

  it("rejects missing, oversized, and malformed raw messages", async () => {
    await expect(
      parseNotifyUwNotification(createCandidate(null), createOptions()),
    ).resolves.toEqual({ accepted: false, reason: "source_missing" });

    await expect(
      parseNotifyUwNotification(
        createCandidate(fixture, { size: 300_000 }),
        createOptions(),
      ),
    ).resolves.toEqual({ accepted: false, reason: "message_too_large" });

    const oversizedHeader = Buffer.from(
      `X-Oversized: ${"a".repeat(70_000)}\r\n\r\nbody`,
    );
    await expect(
      parseNotifyUwNotification(
        createCandidate(oversizedHeader, { size: oversizedHeader.byteLength }),
        createOptions(),
      ),
    ).resolves.toEqual({ accepted: false, reason: "malformed_email" });
  });

  it("rejects ambiguous and non-allowlisted SLNs", async () => {
    const ambiguous = changedFixture(
      "Do NOT reply to this email.",
      "Do NOT reply to this email. Alternate (SLN: 54321).",
    );
    await expect(
      parseNotifyUwNotification(
        createCandidate(ambiguous),
        createOptions({ allowedSlns: ["12345", "54321"] }),
      ),
    ).resolves.toEqual({ accepted: false, reason: "ambiguous_sln" });

    await expect(
      parseNotifyUwNotification(
        createCandidate(),
        createOptions({ allowedSlns: ["54321"] }),
      ),
    ).resolves.toEqual({ accepted: false, reason: "sln_not_allowed" });
  });

  it("rejects messages containing attachments", async () => {
    const original = fixture.toString("utf8");
    const [headers, html] = original.split(/\r?\n\r?\n/, 2);
    expect(headers).toBeTruthy();
    expect(html).toBeTruthy();
    const multipartHeaders = headers?.replace(
      "Content-Type: text/html; charset=us-ascii",
      'Content-Type: multipart/mixed; boundary="autograb-test"',
    );
    const multipart = Buffer.from(
      `${multipartHeaders}\r\n\r\n` +
        `--autograb-test\r\nContent-Type: text/html; charset=us-ascii\r\n\r\n${html}\r\n` +
        "--autograb-test\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=extra.txt\r\n\r\nextra\r\n" +
        "--autograb-test--\r\n",
    );

    await expect(
      parseNotifyUwNotification(createCandidate(multipart), createOptions()),
    ).resolves.toEqual({
      accepted: false,
      reason: "unexpected_attachment",
    });
  });
});
