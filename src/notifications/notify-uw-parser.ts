import PostalMime, { type Address, type Email } from "postal-mime";

import type { CandidateEmail } from "../email/types.js";
import { NOTIFY_UW } from "../email/gmail/constants.js";

const SUBJECT_PATTERN = /^Notify\.UW:\s+(.+?)\s+has seats available$/;
const BODY_OPENING_PATTERN =
  /^(.+?)\s+\(SLN:\s*(\d{5})\)\s+has seats available\.\s+Go to UW Registration\s*\./;
const SLN_OCCURRENCE_PATTERN = /\bSLN:\s*(\d+)\b/g;
const FUTURE_CLOCK_TOLERANCE_MS = 2 * 60 * 1_000;

export type NotificationRejectionReason =
  | "source_missing"
  | "message_too_large"
  | "malformed_email"
  | "sender_mismatch"
  | "recipient_mismatch"
  | "message_id_mismatch"
  | "subject_mismatch"
  | "authentication_failed"
  | "stale_notification"
  | "invalid_timestamp"
  | "unexpected_attachment"
  | "structure_mismatch"
  | "ambiguous_sln"
  | "sln_not_allowed";

export interface TrustedSeatNotification {
  readonly sourceUidValidity: string;
  readonly sourceUid: string;
  readonly sourceMessageId: string;
  readonly course: string;
  readonly sln: string;
  readonly receivedAt: Date;
}

export type NotifyUwParseResult =
  | { accepted: true; notification: TrustedSeatNotification }
  | { accepted: false; reason: NotificationRejectionReason };

export interface NotifyUwParserOptions {
  expectedRecipient: string;
  allowedSlns: readonly string[];
  maxAgeMs: number;
  maxMessageBytes?: number;
  now?: Date;
}

function reject(reason: NotificationRejectionReason): NotifyUwParseResult {
  return { accepted: false, reason };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal) {
        const codePoint = Number(decimal);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return named ? (namedEntities[named.toLowerCase()] ?? entity) : entity;
    },
  );
}

function htmlToText(html: string): string {
  const withoutActiveContent = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
  const withBoundaries = withoutActiveContent.replace(
    /<\/?(?:p|div|br|hr|li|tr|td|h[1-6])\b[^>]*>/gi,
    " ",
  );
  return normalizeWhitespace(decodeHtmlEntities(withBoundaries.replace(/<[^>]*>/g, " ")));
}

function flattenAddresses(addresses: Address[] | undefined): string[] {
  return (addresses ?? []).flatMap((address) =>
    "group" in address && address.group
      ? address.group.map((member) => member.address.toLowerCase())
      : address.address
        ? [address.address.toLowerCase()]
        : [],
  );
}

function singleAddress(address: Address | undefined): string | null {
  if (!address || ("group" in address && address.group)) return null;
  return address.address?.toLowerCase() ?? null;
}

function hasTrustedAuthenticationResults(email: Email): boolean {
  const result = email.headers
    .filter((header) => header.key === "authentication-results")
    .map((header) => normalizeWhitespace(header.value).toLowerCase())
    .find((value) => /^mx\.google\.com\s*;/.test(value));

  if (!result) return false;

  const segments = result.split(";").map(normalizeWhitespace);
  const dkimAligned = segments.some(
    (segment) =>
      /\bdkim=pass\b/.test(segment) &&
      /\bheader\.(?:i|d)=@?uw\.edu(?:\s|$)/.test(segment),
  );
  const dmarcAligned = segments.some(
    (segment) =>
      /\bdmarc=pass\b/.test(segment) &&
      /\bheader\.from=uw\.edu(?:\s|$)/.test(segment),
  );
  const spfPassed = segments.some((segment) => /\bspf=pass\b/.test(segment));
  return dkimAligned && dmarcAligned && spfPassed;
}

function containsRegistrationLink(html: string): boolean {
  const hrefPattern =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

  for (const match of html.matchAll(hrefPattern)) {
    const rawHref = match[1] ?? match[2] ?? match[3];
    if (!rawHref) continue;

    try {
      const url = new URL(decodeHtmlEntities(rawHref));
      if (
        url.origin === NOTIFY_UW.registrationOrigin &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      ) {
        return true;
      }
    } catch {
      // Ignore malformed links and continue checking the bounded message body.
    }
  }

  return false;
}

function normalizedCourse(value: string): string {
  return normalizeWhitespace(value);
}

export async function parseNotifyUwNotification(
  candidate: CandidateEmail,
  options: NotifyUwParserOptions,
): Promise<NotifyUwParseResult> {
  if (!candidate.rawSource) return reject("source_missing");

  const maxMessageBytes = options.maxMessageBytes ?? NOTIFY_UW.maxMessageBytes;
  if (
    candidate.rawSource.byteLength > maxMessageBytes ||
    (candidate.size !== null && candidate.size > maxMessageBytes)
  ) {
    return reject("message_too_large");
  }

  let email: Email;
  try {
    email = await PostalMime.parse(candidate.rawSource, {
      maxHeadersSize: 64 * 1_024,
      maxNestingDepth: 16,
      maxRfc822NestingDepth: 4,
      attachmentEncoding: "arraybuffer",
    });
  } catch {
    return reject("malformed_email");
  }

  const expectedSender = NOTIFY_UW.sender.toLowerCase();
  if (
    singleAddress(email.from) !== expectedSender ||
    candidate.from.length !== 1 ||
    candidate.from[0]?.toLowerCase() !== expectedSender
  ) {
    return reject("sender_mismatch");
  }

  const expectedRecipient = options.expectedRecipient.toLowerCase();
  if (!flattenAddresses(email.to).includes(expectedRecipient)) {
    return reject("recipient_mismatch");
  }

  if (
    !email.messageId ||
    !candidate.messageId ||
    email.messageId !== candidate.messageId
  ) {
    return reject("message_id_mismatch");
  }

  if (!email.subject || email.subject !== candidate.subject) {
    return reject("subject_mismatch");
  }
  const subjectMatch = SUBJECT_PATTERN.exec(email.subject);
  if (!subjectMatch?.[1]) return reject("subject_mismatch");

  if (!hasTrustedAuthenticationResults(email)) {
    return reject("authentication_failed");
  }

  const now = options.now ?? new Date();
  const receivedAtMs = candidate.receivedAt.getTime();
  const nowMs = now.getTime();
  if (
    Number.isNaN(receivedAtMs) ||
    Number.isNaN(nowMs) ||
    !email.date ||
    Number.isNaN(new Date(email.date).getTime()) ||
    receivedAtMs > nowMs + FUTURE_CLOCK_TOLERANCE_MS
  ) {
    return reject("invalid_timestamp");
  }
  if (nowMs - receivedAtMs > options.maxAgeMs) {
    return reject("stale_notification");
  }

  if (email.attachments.length > 0) {
    return reject("unexpected_attachment");
  }
  if (!email.html || !containsRegistrationLink(email.html)) {
    return reject("structure_mismatch");
  }

  const body = htmlToText(email.html);
  const slnOccurrences = [...body.matchAll(SLN_OCCURRENCE_PATTERN)];
  if (slnOccurrences.length !== 1) return reject("ambiguous_sln");

  const bodyMatch = BODY_OPENING_PATTERN.exec(body);
  const bodyCourse = bodyMatch?.[1];
  const sln = bodyMatch?.[2];
  if (!bodyCourse || !sln) return reject("structure_mismatch");
  if (normalizedCourse(subjectMatch[1]) !== normalizedCourse(bodyCourse)) {
    return reject("structure_mismatch");
  }
  if (!options.allowedSlns.includes(sln)) {
    return reject("sln_not_allowed");
  }

  return {
    accepted: true,
    notification: {
      sourceUidValidity: candidate.uidValidity,
      sourceUid: candidate.uid,
      sourceMessageId: email.messageId,
      course: normalizedCourse(bodyCourse),
      sln,
      receivedAt: candidate.receivedAt,
    },
  };
}
