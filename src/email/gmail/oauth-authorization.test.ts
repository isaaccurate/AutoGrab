import { describe, expect, it } from "vitest";

import { validateLoopbackRedirectUri } from "./oauth-authorization.js";

describe("validateLoopbackRedirectUri", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("accepts desktop loopback URL %s", (value) => {
    expect(validateLoopbackRedirectUri(value).port).toBe("3000");
  });

  it.each([
    "https://localhost:3000",
    "http://example.com:3000",
    "http://localhost",
    "http://user@localhost:3000",
    "http://localhost:3000?token=value",
  ])("rejects unsafe redirect URL %s", (value) => {
    expect(() => validateLoopbackRedirectUri(value)).toThrow(
      "must be an HTTP loopback URL",
    );
  });
});
