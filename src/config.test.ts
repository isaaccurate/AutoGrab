import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("parses required settings and keeps dry-run enabled by default", () => {
    const config = loadConfig({
      AUTOGRAB_EMAIL_ADDRESS: "student@gmail.com",
      AUTOGRAB_GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      AUTOGRAB_GOOGLE_CLIENT_SECRET: "test-client-secret",
      AUTOGRAB_ALLOWED_SENDERS:
        "registration@example.edu, notifier@example.edu",
      AUTOGRAB_TARGET_SLNS: "12345,67890",
      AUTOGRAB_TARGET_QUARTER: "au26",
    });

    expect(config.googleClientId).toBe(
      "test-client-id.apps.googleusercontent.com",
    );
    expect(config.googleRedirectUri).toBe(
      "http://localhost:3000",
    );
    expect(config.imapHost).toBe("imap.gmail.com");
    expect(config.imapPort).toBe(993);
    expect(config.allowedSenders).toEqual([
      "registration@example.edu",
      "notifier@example.edu",
    ]);
    expect(config.targetSlns).toEqual(["12345", "67890"]);
    expect(config.targetQuarter).toBe("au26");
    expect(config.notificationMaxAgeMs).toBe(600_000);
    expect(config.registrationMode).toBe("dry-run");
  });

  it("accepts live as the single registration mode lock", () => {
    const config = loadConfig({
      AUTOGRAB_EMAIL_ADDRESS: "student@gmail.com",
      AUTOGRAB_GOOGLE_CLIENT_ID: "client-id",
      AUTOGRAB_GOOGLE_CLIENT_SECRET: "client-secret",
      AUTOGRAB_ALLOWED_SENDERS: "notify-noreply@uw.edu",
      AUTOGRAB_TARGET_SLNS: "12345",
      AUTOGRAB_TARGET_QUARTER: "au26",
      AUTOGRAB_REGISTRATION_MODE: "live",
    });

    expect(config.registrationMode).toBe("live");
  });

  it("rejects unknown registration modes", () => {
    expect(() =>
      loadConfig({
        AUTOGRAB_EMAIL_ADDRESS: "student@gmail.com",
        AUTOGRAB_GOOGLE_CLIENT_ID: "client-id",
        AUTOGRAB_GOOGLE_CLIENT_SECRET: "client-secret",
        AUTOGRAB_ALLOWED_SENDERS: "notify-noreply@uw.edu",
        AUTOGRAB_TARGET_SLNS: "12345",
        AUTOGRAB_TARGET_QUARTER: "au26",
        AUTOGRAB_REGISTRATION_MODE: "automatic-ish",
      }),
    ).toThrow();
  });

  it("rejects malformed target SLNs", () => {
    expect(() =>
      loadConfig({
        AUTOGRAB_EMAIL_ADDRESS: "student@gmail.com",
        AUTOGRAB_GOOGLE_CLIENT_ID: "client-id",
        AUTOGRAB_GOOGLE_CLIENT_SECRET: "client-secret",
        AUTOGRAB_ALLOWED_SENDERS: "notify-noreply@uw.edu",
        AUTOGRAB_TARGET_SLNS: "1234,not-an-sln",
        AUTOGRAB_TARGET_QUARTER: "au26",
      }),
    ).toThrow("Every target SLN must contain exactly five digits");
  });
});
