import { describe, expect, it } from "vitest";

import {
  classifyRegistrationPage,
  expectedQuarterLabel,
  prepareRegistrationDryRun,
  prepareSlnsForCart,
  registrationUrl,
  waitForRegistrationPageReady,
  type RegistrationPageDriver,
} from "./uw-registration-page.js";

interface PageSnapshot {
  readonly url: string;
  readonly quarterText: string | null;
  readonly inputVisible: boolean;
}

class SequencedRegistrationPage implements RegistrationPageDriver {
  private index = -1;
  private current: PageSnapshot;

  constructor(private readonly snapshots: readonly PageSnapshot[]) {
    if (snapshots.length === 0) throw new Error("A snapshot is required.");
    this.current = snapshots[0]!;
  }

  async currentUrl(): Promise<string> {
    this.index = Math.min(this.index + 1, this.snapshots.length - 1);
    this.current = this.snapshots[this.index]!;
    return this.current.url;
  }

  async selectedQuarterText(): Promise<string | null> {
    return this.current.quarterText;
  }

  async isSlnInputVisible(): Promise<boolean> {
    return this.current.inputVisible;
  }

  async registeredSlns(): Promise<readonly string[]> {
    return [];
  }

  async fillSln(): Promise<void> {
    throw new Error("The readiness wait must not fill an SLN.");
  }

  async readSln(): Promise<string> {
    return "";
  }
}

class FakeRegistrationPage implements RegistrationPageDriver {
  fillCount = 0;
  value = "";

  constructor(
    private readonly url: string,
    private readonly quarterText: string | null = "Autumn 2026",
    private readonly inputVisible = true,
    private readonly registered: readonly string[] = [],
    private readonly retainFill = true,
  ) {}

  async currentUrl(): Promise<string> {
    return this.url;
  }

  async selectedQuarterText(): Promise<string | null> {
    return this.quarterText;
  }

  async isSlnInputVisible(): Promise<boolean> {
    return this.inputVisible;
  }

  async registeredSlns(): Promise<readonly string[]> {
    return this.registered;
  }

  async fillSln(sln: string): Promise<void> {
    this.fillCount += 1;
    if (this.retainFill) this.value = sln;
  }

  async readSln(): Promise<string> {
    return this.value;
  }
}

describe("UW registration page safety", () => {
  it("builds and labels supported quarter routes", () => {
    expect(registrationUrl("au26")).toBe(
      "https://register.uw.edu/register/#/au26",
    );
    expect(expectedQuarterLabel("wi27")).toBe("Winter 2027");
    expect(() => registrationUrl("fall-2026")).toThrow("quarter is invalid");
  });

  it.each([
    [
      "login_required",
      new FakeRegistrationPage(
        "https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO",
        null,
        false,
      ),
    ],
    [
      "wrong_quarter",
      new FakeRegistrationPage(
        "https://register.uw.edu/register/#/su26",
        "Summer 2026",
      ),
    ],
    [
      "wrong_quarter",
      new FakeRegistrationPage(
        "https://register.uw.edu/register/#/au26",
        "Summer 2026",
      ),
    ],
    [
      "unavailable",
      new FakeRegistrationPage(
        "https://register.uw.edu/register/#/au26",
        "Autumn 2026",
        false,
      ),
    ],
    [
      "unavailable",
      new FakeRegistrationPage("https://example.test/register/#/au26"),
    ],
    [
      "ready",
      new FakeRegistrationPage("https://register.uw.edu/register/#/au26"),
    ],
  ] as const)("classifies %s without changing the page", async (state, page) => {
    await expect(classifyRegistrationPage(page, "au26")).resolves.toBe(state);
    expect(page.fillCount).toBe(0);
  });

  it("recognizes an already registered SLN without filling the form", async () => {
    const page = new FakeRegistrationPage(
      "https://register.uw.edu/register/#/au26",
      "Autumn 2026",
      true,
      ["12345"],
    );

    await expect(
      prepareRegistrationDryRun(page, "au26", "12345"),
    ).resolves.toEqual({ status: "already_registered", sln: "12345" });
    expect(page.fillCount).toBe(0);
  });

  it("waits through transient SPA states until the target quarter is ready", async () => {
    const page = new SequencedRegistrationPage([
      {
        url: "https://register.uw.edu/register/#/su26",
        quarterText: "Summer 2026",
        inputVisible: true,
      },
      {
        url: "https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO",
        quarterText: null,
        inputVisible: false,
      },
      {
        url: "about:blank",
        quarterText: null,
        inputVisible: false,
      },
      {
        url: "https://register.uw.edu/register/#/au26",
        quarterText: "Summer 2026",
        inputVisible: true,
      },
      {
        url: "https://register.uw.edu/register/#/au26",
        quarterText: "Autumn 2026",
        inputVisible: true,
      },
    ]);
    let currentTime = 0;

    await expect(
      waitForRegistrationPageReady(page, "au26", {
        timeoutMs: 1_000,
        pollIntervalMs: 100,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toBe("ready");
    expect(currentTime).toBe(400);
  });

  it("retries when a Playwright page read is interrupted by navigation", async () => {
    let quarterReadCount = 0;
    const page = new FakeRegistrationPage(
      "https://register.uw.edu/register/#/au26",
    );
    page.selectedQuarterText = async () => {
      quarterReadCount += 1;
      if (quarterReadCount === 1) {
        throw new Error("Execution context was destroyed during navigation");
      }
      return "Autumn 2026";
    };
    let currentTime = 0;

    await expect(
      waitForRegistrationPageReady(page, "au26", {
        timeoutMs: 500,
        pollIntervalMs: 100,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toBe("ready");
    expect(currentTime).toBe(100);
  });

  it("returns the last observed state when stabilization times out", async () => {
    const page = new SequencedRegistrationPage([
      {
        url: "https://register.uw.edu/register/#/su26",
        quarterText: "Summer 2026",
        inputVisible: true,
      },
    ]);
    let currentTime = 0;

    await expect(
      waitForRegistrationPageReady(page, "au26", {
        timeoutMs: 200,
        pollIntervalMs: 100,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toBe("wrong_quarter");
    expect(currentTime).toBe(200);
  });

  it("fills exactly one validated SLN without exposing a submission operation", async () => {
    const page = new FakeRegistrationPage(
      "https://register.uw.edu/register/#/au26",
    );

    await expect(
      prepareRegistrationDryRun(page, "au26", "12345"),
    ).resolves.toEqual({ status: "prepared", sln: "12345" });
    expect(page.fillCount).toBe(1);
    expect(page.value).toBe("12345");
    expect("submit" in page).toBe(false);
  });

  it("fills every missing bundle member in one registration entry", async () => {
    const page = new FakeRegistrationPage(
      "https://register.uw.edu/register/#/au26",
      "Autumn 2026",
      true,
      ["12345"],
    );

    await expect(
      prepareSlnsForCart(page, ["12345", "54321", "67890"]),
    ).resolves.toEqual({
      status: "prepared",
      slns: ["54321", "67890"],
    });
    expect(page.fillCount).toBe(1);
    expect(page.value).toBe("54321 67890");
  });

  it("fails closed for malformed or unretained SLNs", async () => {
    const page = new FakeRegistrationPage(
      "https://register.uw.edu/register/#/au26",
      "Autumn 2026",
      true,
      [],
      false,
    );

    await expect(
      prepareRegistrationDryRun(page, "au26", "1234"),
    ).rejects.toThrow("exactly five digits");
    await expect(
      prepareRegistrationDryRun(page, "au26", "12345"),
    ).rejects.toThrow("did not retain");
  });
});
