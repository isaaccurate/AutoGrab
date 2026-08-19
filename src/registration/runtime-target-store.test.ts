import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeTargetSlnStore } from "./runtime-target-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("RuntimeTargetSlnStore", () => {
  it("uses configuration as fallback and persists normalized targets privately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-targets-"));
    directories.push(directory);
    const path = join(directory, "private", "target-slns.json");
    const store = new RuntimeTargetSlnStore(path);

    expect(store.load(["12345"])).toEqual(["12345"]);
    expect(store.save([" 54321 ", "12345", "54321"])).toEqual([
      "54321",
      "12345",
    ]);
    expect(store.load(["99999"])).toEqual(["54321", "12345"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 2,
      targets: [["54321"], ["12345"]],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it("persists bundles and reads legacy singleton target files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-targets-"));
    directories.push(directory);
    const path = join(directory, "target-slns.json");
    const store = new RuntimeTargetSlnStore(path);

    expect(store.saveTargets([["13277", "13280"], ["14693"]])).toEqual([
      { key: "13277+13280", slns: ["13277", "13280"] },
      { key: "14693", slns: ["14693"] },
    ]);
    expect(store.load(["99999"])).toEqual(["13277", "13280", "14693"]);

    await writeFile(path, '{"version":1,"slns":["12345","54321"]}\n');
    expect(store.loadTargets(["99999"])).toEqual([
      { key: "12345", slns: ["12345"] },
      { key: "54321", slns: ["54321"] },
    ]);
  });

  it("persists alternative bundles that share a lecture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-targets-"));
    directories.push(directory);
    const path = join(directory, "target-slns.json");
    const store = new RuntimeTargetSlnStore(path);

    expect(
      store.saveTargets([
        ["13277", "13278"],
        ["13277", "13279"],
        ["13277", "13280"],
      ]),
    ).toEqual([
      { key: "13277+13278", slns: ["13277", "13278"] },
      { key: "13277+13279", slns: ["13277", "13279"] },
      { key: "13277+13280", slns: ["13277", "13280"] },
    ]);
    expect(store.load([])).toEqual(["13277", "13278", "13279", "13280"]);
  });

  it("rejects empty, malformed, corrupt, and symbolic-link targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autograb-targets-"));
    directories.push(directory);
    const path = join(directory, "target-slns.json");
    const store = new RuntimeTargetSlnStore(path);

    expect(() => store.save([])).toThrow("At least one");
    expect(() => store.save(["1234"])).toThrow("exactly five digits");
    await writeFile(path, "not-json", "utf8");
    expect(() => store.load(["12345"])).toThrow();
    await rm(path);
    const target = join(directory, "target.json");
    await writeFile(target, '{"version":1,"slns":["12345"]}\n');
    await symlink(target, path);
    expect(() => store.load(["12345"])).toThrow("not a regular file");
  });
});
