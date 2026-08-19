import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileRefreshTokenStore } from "./token-store.js";

const temporaryDirectories: string[] = [];

async function createTokenStore(): Promise<{
  directory: string;
  tokenPath: string;
  store: FileRefreshTokenStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "autograb-token-store-"));
  temporaryDirectories.push(directory);
  const tokenPath = join(directory, "credentials", "google-oauth.json");

  return {
    directory,
    tokenPath,
    store: new FileRefreshTokenStore(tokenPath),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileRefreshTokenStore", () => {
  it("writes and reads a refresh credential with private permissions", async () => {
    const { tokenPath, store } = await createTokenStore();

    await store.save("test-refresh-token");

    expect(await store.load()).toBe("test-refresh-token");
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(tokenPath, ".."))).mode & 0o777).toBe(0o700);
    expect(await readFile(tokenPath, "utf8")).not.toContain("access_token");
  });

  it("rejects a credential file with group or public access", async () => {
    const { tokenPath, store } = await createTokenStore();
    await store.save("test-refresh-token");
    await chmod(tokenPath, 0o644);

    await expect(store.load()).rejects.toThrow("unsafe permissions");
  });

  it("rejects malformed credential data without echoing it", async () => {
    const { tokenPath, store } = await createTokenStore();
    await store.save("initial-token");
    await writeFile(tokenPath, '{"refreshToken":"secret-value"}', {
      mode: 0o600,
    });

    await expect(store.load()).rejects.toThrow(
      "Unable to read the stored Gmail refresh credential.",
    );
    await expect(store.load()).rejects.not.toThrow("secret-value");
  });
});
