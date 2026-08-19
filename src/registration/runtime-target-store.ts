import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  flattenedTargetSlns,
  normalizeRegistrationTargets,
  singletonRegistrationTargets,
  type RegistrationTarget,
} from "./registration-target.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface LegacyTargetFile {
  readonly version: 1;
  readonly slns: readonly string[];
}

interface TargetFile {
  readonly version: 2;
  readonly targets: readonly (readonly string[])[];
}

export function defaultRuntimeTargetPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "AutoGrab",
    "target-slns.json",
  );
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The runtime target directory is not a regular directory.");
  }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

export class RuntimeTargetSlnStore {
  constructor(readonly path = defaultRuntimeTargetPath()) {}

  load(fallback: readonly string[]): readonly string[] {
    return flattenedTargetSlns(this.loadTargets(fallback));
  }

  loadTargets(fallback: readonly string[]): readonly RegistrationTarget[] {
    if (!existsSync(this.path)) return singletonRegistrationTargets(fallback);
    const metadata = lstatSync(this.path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The runtime target path is not a regular file.");
    }
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as
      | Partial<TargetFile>
      | Partial<LegacyTargetFile>;
    if (parsed.version === 1 && Array.isArray(parsed.slns)) {
      return singletonRegistrationTargets(parsed.slns);
    }
    if (parsed.version === 2 && Array.isArray(parsed.targets)) {
      return normalizeRegistrationTargets(parsed.targets);
    }
    throw new Error("The runtime target file is invalid.");
  }

  save(values: readonly string[]): readonly string[] {
    return flattenedTargetSlns(
      this.saveTargets(values.map((value) => [value])),
    );
  }

  saveTargets(
    values: readonly (readonly string[])[],
  ): readonly RegistrationTarget[] {
    const targets = normalizeRegistrationTargets(values);
    const directory = dirname(this.path);
    ensurePrivateDirectory(directory);
    if (existsSync(this.path)) {
      const metadata = lstatSync(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("The runtime target path is not a regular file.");
      }
    }

    const temporaryPath = join(
      directory,
      `.target-slns.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({
          version: 2,
          targets: targets.map((target) => target.slns),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: PRIVATE_FILE_MODE },
      );
      chmodSync(temporaryPath, PRIVATE_FILE_MODE);
      renameSync(temporaryPath, this.path);
      chmodSync(this.path, PRIVATE_FILE_MODE);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created or was already renamed.
      }
      throw error;
    }
    return targets;
  }
}
