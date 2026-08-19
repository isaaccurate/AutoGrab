import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LiveRegistrationKillSwitch } from "./live-kill-switch.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LiveRegistrationKillSwitch", () => {
  it("is clear by default and trips on a stop file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-live-stop-"));
    directories.push(directory);
    const path = join(directory, "LIVE_STOP");
    const killSwitch = new LiveRegistrationKillSwitch(path);

    expect(killSwitch.stopReason()).toBeNull();
    expect(() => killSwitch.assertClear()).not.toThrow();

    await writeFile(path, "stop\n", { mode: 0o600 });
    expect(killSwitch.stopReason()).toBe("file");
    expect(() => killSwitch.assertClear()).toThrow("kill switch");
  });

  it("trips immediately when a process signal requests shutdown", () => {
    const killSwitch = new LiveRegistrationKillSwitch("/does/not/exist");

    killSwitch.requestStop();

    expect(killSwitch.stopReason()).toBe("signal");
    expect(() => killSwitch.assertClear()).toThrow("kill switch");
  });
});
