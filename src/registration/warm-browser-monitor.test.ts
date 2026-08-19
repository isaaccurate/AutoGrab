import { describe, expect, it, vi } from "vitest";

import { monitorWarmRegistrationBrowser } from "./warm-browser-monitor.js";
import type { RegistrationPageDriver } from "./uw-registration-page.js";

class SequencedPage implements RegistrationPageDriver {
  private index = -1;
  private state: "login" | "ready" | "wrong" = "login";

  constructor(
    private readonly states: readonly ("login" | "ready" | "wrong")[],
  ) {}

  async currentUrl(): Promise<string> {
    this.index = Math.min(this.index + 1, this.states.length - 1);
    this.state = this.states[this.index] ?? "login";
    if (this.state === "login") {
      return "https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO";
    }
    return this.state === "ready"
      ? "https://register.uw.edu/register/#/au26"
      : "https://register.uw.edu/register/#/su26";
  }

  async selectedQuarterText(): Promise<string | null> {
    return this.state === "ready" ? "Autumn 2026" : "Summer 2026";
  }

  async isSlnInputVisible(): Promise<boolean> {
    return this.state === "ready";
  }

  async registeredSlns(): Promise<readonly string[]> {
    return [];
  }

  async fillSln(): Promise<void> {}

  async readSln(): Promise<string> {
    return "";
  }
}

describe("monitorWarmRegistrationBrowser", () => {
  it("reports state changes and dispatches readiness on each ready transition", async () => {
    const states = ["login", "login", "ready", "ready", "wrong", "ready"] as const;
    const page = new SequencedPage(states);
    const onState = vi.fn();
    const onReady = vi.fn();
    let iterations = 0;

    await monitorWarmRegistrationBrowser({
      page,
      targetQuarter: "au26",
      shouldStop: () => iterations >= states.length,
      onState,
      onReady,
      pollIntervalMs: 1,
      sleep: async () => {
        iterations += 1;
      },
    });

    expect(onState.mock.calls.map(([state]) => state)).toEqual([
      "login_required",
      "ready",
      "wrong_quarter",
      "ready",
    ]);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid polling interval before reading the page", async () => {
    const page = new SequencedPage(["ready"]);
    const currentUrl = vi.spyOn(page, "currentUrl");

    await expect(
      monitorWarmRegistrationBrowser({
        page,
        targetQuarter: "au26",
        shouldStop: () => false,
        onState: () => undefined,
        onReady: () => undefined,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("poll interval");
    expect(currentUrl).not.toHaveBeenCalled();
  });
});
