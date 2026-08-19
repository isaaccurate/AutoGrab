import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LiveStopReason = "file" | "signal" | null;

export function defaultLiveKillSwitchPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "AutoGrab",
    "LIVE_STOP",
  );
}

export class LiveRegistrationKillSwitch {
  private signalRequested = false;

  constructor(
    readonly path = defaultLiveKillSwitchPath(),
  ) {}

  requestStop(): void {
    this.signalRequested = true;
  }

  stopReason(): LiveStopReason {
    if (this.signalRequested) return "signal";
    if (!existsSync(this.path)) return null;
    try {
      const metadata = lstatSync(this.path);
      return metadata.isFile() && !metadata.isSymbolicLink() ? "file" : "file";
    } catch {
      return "file";
    }
  }

  assertClear(): void {
    if (this.stopReason() !== null) {
      throw new Error("Live registration stopped by the kill switch.");
    }
  }
}
