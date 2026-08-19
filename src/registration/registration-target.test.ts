import { describe, expect, it } from "vitest";

import {
  findRegistrationTarget,
  flattenedTargetSlns,
  hasRegistrationTarget,
  normalizeRegistrationTargets,
} from "./registration-target.js";

describe("registration targets", () => {
  it("normalizes singleton and bundled targets with stable keys", () => {
    const targets = normalizeRegistrationTargets([
      [" 13277 ", "13280", "13277"],
      ["14693"],
    ]);

    expect(targets).toEqual([
      { key: "13277+13280", slns: ["13277", "13280"] },
      { key: "14693", slns: ["14693"] },
    ]);
    expect(flattenedTargetSlns(targets)).toEqual(["13277", "13280", "14693"]);
    expect(findRegistrationTarget(targets, "13280")).toEqual(targets[0]);
    expect(hasRegistrationTarget(targets, targets[0]!)).toBe(true);
    expect(normalizeRegistrationTargets([["13280", "13277"]])).toEqual([
      { key: "13277+13280", slns: ["13277", "13280"] },
    ]);
  });

  it("allows ordered alternatives that share a lecture SLN", () => {
    const targets = normalizeRegistrationTargets([
      ["13277", "13278"],
      ["13277", "13279"],
      ["13277", "13280"],
    ]);

    expect(flattenedTargetSlns(targets)).toEqual([
      "13277",
      "13278",
      "13279",
      "13280",
    ]);
    expect(findRegistrationTarget(targets, "13277")).toEqual(targets[0]);
    expect(findRegistrationTarget(targets, "13279")).toEqual(targets[1]);
  });

  it("rejects malformed targets", () => {
    expect(() => normalizeRegistrationTargets([])).toThrow("At least one");
    expect(() => normalizeRegistrationTargets([["1234"]])).toThrow(
      "exactly five digits",
    );
  });
});
