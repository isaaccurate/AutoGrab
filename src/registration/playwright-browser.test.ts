import { describe, expect, it } from "vitest";

import {
  dryRunDomGuardScript,
  isBlockedRegistrationAction,
  isReadOnlyRequestMethod,
} from "./playwright-browser.js";

describe("Playwright dry-run network policy", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get"])(
    "permits the read-only %s method",
    (method) => {
      expect(isReadOnlyRequestMethod(method)).toBe(true);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "CONNECT"])(
    "blocks the mutating %s method",
    (method) => {
      expect(isReadOnlyRequestMethod(method)).toBe(false);
    },
  );

  it("targets only the two observed registration mutation controls", () => {
    expect(isBlockedRegistrationAction("Add to cart")).toBe(true);
    expect(isBlockedRegistrationAction("Update Schedule")).toBe(true);
    expect(isBlockedRegistrationAction("Enter SLN")).toBe(false);
    expect(isBlockedRegistrationAction("Sign out")).toBe(false);
  });

  it("builds a self-contained browser guard without runtime helpers", () => {
    const script = dryRunDomGuardScript(["Add to cart", "Update Schedule"]);

    expect(script).toContain('new Set(["Add to cart","Update Schedule"])');
    expect(script).toContain('document.addEventListener("submit"');
    expect(script).not.toContain("__name");
  });
});
