import { describe, expect, it, vi } from "vitest";

import {
  alertBody,
  alertTitle,
  CompositeRegistrationAlertSink,
  type RegistrationAlert,
  type RegistrationAlertSink,
} from "./registration-alerts.js";

const ALERT: RegistrationAlert = {
  state: "uncertain",
  course: "TEST 101 A",
  sln: "12345",
  slns: ["12345"],
  failureCode: "result_timeout",
};

describe("registration alerts", () => {
  it("contains only the sanitized job identity and stable outcome code", () => {
    expect(alertTitle(ALERT)).toBe("Registration result uncertain");
    expect(alertBody(ALERT)).toBe(
      "TEST 101 A · SLN 12345 (result_timeout)",
    );
  });

  it("shows every member of a bundled target", () => {
    expect(alertBody({ ...ALERT, slns: ["12345", "54321"] })).toBe(
      "TEST 101 A · SLNs 12345 + 54321 (result_timeout)",
    );
  });

  it("succeeds when at least one independent alert channel succeeds", async () => {
    const succeeded: RegistrationAlertSink = { send: vi.fn(async () => undefined) };
    const failed: RegistrationAlertSink = {
      send: vi.fn(async () => {
        throw new Error("channel unavailable");
      }),
    };

    await expect(
      new CompositeRegistrationAlertSink([failed, succeeded]).send(ALERT),
    ).resolves.toBeUndefined();
  });

  it("reports failure when every configured channel fails", async () => {
    const failed: RegistrationAlertSink = {
      send: vi.fn(async () => {
        throw new Error("channel unavailable");
      }),
    };

    await expect(
      new CompositeRegistrationAlertSink([failed]).send(ALERT),
    ).rejects.toThrow("Every registration alert channel failed");
  });
});
