import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TOKEN_FILE_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface StoredRefreshToken {
  version: typeof TOKEN_FILE_VERSION;
  refreshToken: string;
}

export interface RefreshTokenStore {
  load(): Promise<string>;
  save(refreshToken: string): Promise<void>;
}

export function defaultRefreshTokenPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "AutoGrab",
    "google-oauth.json",
  );
}

function assertRefreshToken(refreshToken: unknown): asserts refreshToken is string {
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw new Error("The stored Gmail refresh credential is invalid.");
  }
}

export class FileRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly tokenPath = defaultRefreshTokenPath()) {}

  async load(): Promise<string> {
    let metadata;

    try {
      metadata = await lstat(this.tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Gmail authorization is missing. Run `npm run oauth:gmail` first.",
        );
      }
      throw new Error("Unable to inspect the Gmail refresh credential.");
    }

    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The Gmail refresh credential path is not a regular file.");
    }

    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        "The Gmail refresh credential has unsafe permissions; expected mode 0600.",
      );
    }

    try {
      const raw = await readFile(this.tokenPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredRefreshToken>;

      if (parsed.version !== TOKEN_FILE_VERSION) {
        throw new Error("Unsupported credential version.");
      }

      assertRefreshToken(parsed.refreshToken);
      return parsed.refreshToken;
    } catch {
      throw new Error("Unable to read the stored Gmail refresh credential.");
    }
  }

  async save(refreshToken: string): Promise<void> {
    assertRefreshToken(refreshToken);

    const tokenDirectory = dirname(this.tokenPath);
    const temporaryPath = join(
      tokenDirectory,
      `.google-oauth.${randomUUID()}.tmp`,
    );
    const payload: StoredRefreshToken = {
      version: TOKEN_FILE_VERSION,
      refreshToken,
    };

    await mkdir(tokenDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    await chmod(tokenDirectory, PRIVATE_DIRECTORY_MODE);

    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      await rename(temporaryPath, this.tokenPath);
      await chmod(this.tokenPath, PRIVATE_FILE_MODE);
    } catch {
      await rm(temporaryPath, { force: true });
      throw new Error("Unable to store the Gmail refresh credential securely.");
    }
  }
}
