import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

export function defaultPlaywrightBrowsersPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "AutoGrab",
    "ms-playwright",
  );
}

export function defaultUwBrowserProfilePath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "AutoGrab",
    "uw-browser-profile",
  );
}

export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!existsSync(directory)) {
    throw new Error("Unable to create the private browser directory.");
  }
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The private browser path is not a regular directory.");
  }
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}
