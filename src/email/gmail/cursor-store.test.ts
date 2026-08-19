import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileMailboxCursorStore } from "./cursor-store.js";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  cursorPath: string;
  store: FileMailboxCursorStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "autograb-cursor-store-"));
  temporaryDirectories.push(directory);
  const cursorPath = join(directory, "state", "gmail-cursor.json");
  return {
    cursorPath,
    store: new FileMailboxCursorStore(cursorPath),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileMailboxCursorStore", () => {
  it("returns null before a cursor has been established", async () => {
    const { store } = await createStore();
    await expect(store.load()).resolves.toBeNull();
  });

  it("atomically stores a cursor with private permissions", async () => {
    const { cursorPath, store } = await createStore();
    const cursor = { uidValidity: "123", lastProcessedUid: "456" };

    await store.save(cursor);

    await expect(store.load()).resolves.toEqual(cursor);
    expect((await stat(cursorPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(cursorPath))).mode & 0o777).toBe(0o700);
  });

  it("rejects unsafe permissions and out-of-range IMAP identifiers", async () => {
    const { cursorPath, store } = await createStore();
    await store.save({ uidValidity: "123", lastProcessedUid: "456" });
    await chmod(cursorPath, 0o644);

    await expect(store.load()).rejects.toThrow("unsafe permissions");
    await expect(
      store.save({
        uidValidity: "4294967296",
        lastProcessedUid: "0",
      }),
    ).rejects.toThrow("cursor is invalid");
  });
});
