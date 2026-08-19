import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { MailboxCursor, MailboxCursorStore } from "../types.js";

const CURSOR_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UID_PATTERN = /^(?:0|[1-9]\d*)$/;
const MAX_IMAP_IDENTIFIER = 4_294_967_295n;

interface StoredCursor extends MailboxCursor {
  version: typeof CURSOR_VERSION;
}

export function defaultCursorPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "AutoGrab",
    "gmail-cursor.json",
  );
}

function assertCursor(cursor: MailboxCursor): void {
  if (
    !UID_PATTERN.test(cursor.uidValidity) ||
    cursor.uidValidity === "0" ||
    !UID_PATTERN.test(cursor.lastProcessedUid) ||
    BigInt(cursor.uidValidity) > MAX_IMAP_IDENTIFIER ||
    BigInt(cursor.lastProcessedUid) > MAX_IMAP_IDENTIFIER
  ) {
    throw new Error("The Gmail mailbox cursor is invalid.");
  }
}

export class FileMailboxCursorStore implements MailboxCursorStore {
  constructor(private readonly cursorPath = defaultCursorPath()) {}

  async load(): Promise<MailboxCursor | null> {
    let metadata;

    try {
      metadata = await lstat(this.cursorPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Unable to inspect the Gmail mailbox cursor.");
    }

    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The Gmail mailbox cursor path is not a regular file.");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        "The Gmail mailbox cursor has unsafe permissions; expected mode 0600.",
      );
    }

    try {
      const parsed = JSON.parse(
        await readFile(this.cursorPath, "utf8"),
      ) as Partial<StoredCursor>;
      const cursor: MailboxCursor = {
        uidValidity: parsed.uidValidity ?? "",
        lastProcessedUid: parsed.lastProcessedUid ?? "",
      };

      if (parsed.version !== CURSOR_VERSION) {
        throw new Error("Unsupported cursor version.");
      }
      assertCursor(cursor);
      return cursor;
    } catch {
      throw new Error("Unable to read the stored Gmail mailbox cursor.");
    }
  }

  async save(cursor: MailboxCursor): Promise<void> {
    assertCursor(cursor);

    const cursorDirectory = dirname(this.cursorPath);
    const temporaryPath = join(
      cursorDirectory,
      `.gmail-cursor.${randomUUID()}.tmp`,
    );
    const payload: StoredCursor = {
      version: CURSOR_VERSION,
      ...cursor,
    };

    await mkdir(cursorDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    await chmod(cursorDirectory, PRIVATE_DIRECTORY_MODE);

    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      await rename(temporaryPath, this.cursorPath);
      await chmod(this.cursorPath, PRIVATE_FILE_MODE);
    } catch {
      await rm(temporaryPath, { force: true });
      throw new Error("Unable to store the Gmail mailbox cursor securely.");
    }
  }
}
