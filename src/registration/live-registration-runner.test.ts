import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SQLiteRegistrationJobStore } from "../jobs/sqlite-job-store.js";
import type { TrustedSeatNotification } from "../notifications/notify-uw-parser.js";
import { runLiveRegistrationAttempt } from "./live-registration-runner.js";
import type { RegistrationAlertSink } from "./registration-alerts.js";
import type { LiveRegistrationPageDriver } from "./uw-registration-page.js";

const directories: string[] = [];
const stores: SQLiteRegistrationJobStore[] = [];

class FakeLivePage implements LiveRegistrationPageDriver {
  value = "";
  cartSlns = new Set<string>();
  addToCartCount = 0;
  submitCount = 0;
  submitted = false;
  submitError = false;
  failureMessage: string | null = null;
  currentUrlCount = 0;

  async currentUrl(): Promise<string> {
    this.currentUrlCount += 1;
    return "https://register.uw.edu/register/#/au26";
  }

  async selectedQuarterText(): Promise<string | null> {
    return "Autumn 2026";
  }

  async isSlnInputVisible(): Promise<boolean> {
    return true;
  }

  async registeredSlns(): Promise<readonly string[]> {
    // Deliberately mirrors Register.UW's broad row-header view: cart SLNs may
    // still be visible after a failed submission. The result message must win.
    return this.submitted ? [...this.cartSlns] : [];
  }

  async fillSln(sln: string): Promise<void> {
    this.value = sln;
  }

  async readSln(): Promise<string> {
    return this.value;
  }

  async addToCart(): Promise<void> {
    this.addToCartCount += 1;
    for (const sln of this.value.split(/[\s,]+/).filter(Boolean)) {
      this.cartSlns.add(sln);
    }
  }

  async cartContainsSln(sln: string): Promise<boolean> {
    return this.cartSlns.has(sln);
  }

  async submitUpdateSchedule(): Promise<void> {
    this.submitCount += 1;
    this.submitted = true;
    if (this.submitError) throw new Error("connection closed");
  }

  async registrationMessages(): Promise<readonly string[]> {
    if (this.failureMessage) return [this.failureMessage];
    return this.submitted
      ? ["Registration was successful. Your schedule has been updated."]
      : [];
  }
}

async function createStore(): Promise<SQLiteRegistrationJobStore> {
  const directory = await mkdtemp(join(tmpdir(), "autograb-live-runner-"));
  directories.push(directory);
  const store = new SQLiteRegistrationJobStore(join(directory, "autograb.sqlite"));
  stores.push(store);
  return store;
}

function notification(): TrustedSeatNotification {
  return {
    sourceUidValidity: "99",
    sourceUid: "101",
    sourceMessageId: "<live@example.test>",
    course: "TEST 101 A",
    sln: "12345",
    receivedAt: new Date("2026-08-18T20:00:00.000Z"),
  };
}

function queue(store: SQLiteRegistrationJobStore, targetSlns?: readonly string[]) {
  return store.enqueueValidatedNotification({
    mailboxAccount: "student@gmail.com",
    notification: notification(),
    ...(targetSlns ? { targetSlns } : {}),
  }).job;
}

function options(
  store: SQLiteRegistrationJobStore,
  jobId: string,
  page: FakeLivePage,
  alerts: RegistrationAlertSink,
) {
  return {
    store,
    page,
    alerts,
    gate: { assertClear: vi.fn(() => undefined) },
    targetQuarter: "au26",
    allowedTargets: [{ key: "12345", slns: ["12345"] }],
    jobId,
    authorizedTargetKey: "12345",
    workerId: "live-test",
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runLiveRegistrationAttempt", () => {
  it("adds the exact SLN to the cart, submits once, and verifies the schedule", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    const send = vi.fn(async () => undefined);

    const result = await runLiveRegistrationAttempt(
      options(store, job.id, page, { send }),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      job: { id: job.id, state: "succeeded" },
    });
    expect([...page.cartSlns]).toEqual(["12345"]);
    expect(page.addToCartCount).toBe(1);
    expect(page.submitCount).toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ state: "succeeded", sln: "12345" }),
    );
    await expect(
      runLiveRegistrationAttempt(
        options(store, job.id, new FakeLivePage(), { send }),
      ),
    ).rejects.toThrow("not eligible");
  });

  it("adds every bundle member to the cart and submits exactly once", async () => {
    const store = await createStore();
    const job = queue(store, ["12345", "54321"]);
    const page = new FakeLivePage();
    const liveOptions = options(store, job.id, page, {
      send: async () => undefined,
    });

    const result = await runLiveRegistrationAttempt({
      ...liveOptions,
      allowedTargets: [{ key: "12345+54321", slns: ["12345", "54321"] }],
      authorizedTargetKey: "12345+54321",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      job: {
        targetKey: "12345+54321",
        slns: ["12345", "54321"],
        state: "succeeded",
      },
    });
    expect([...page.cartSlns]).toEqual(["12345", "54321"]);
    expect(page.addToCartCount).toBe(1);
    expect(page.submitCount).toBe(1);
  });

  it("reuses the warm-browser state and checks readiness only once after claim", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    const liveOptions = options(store, job.id, page, {
      send: async () => undefined,
    });

    await runLiveRegistrationAttempt({
      ...liveOptions,
      initialPageState: "ready",
    });

    expect(page.currentUrlCount).toBe(1);
  });

  it("records an authoritative rejection even when cart rows contain the SLN", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    page.failureMessage =
      "Registration failed, schedule not updated because the section is full.";

    const result = await runLiveRegistrationAttempt(
      options(store, job.id, page, { send: async () => undefined }),
    );

    expect(result).toMatchObject({
      status: "failed",
      job: { state: "failed", failureCode: "seat_unavailable" },
    });
    expect(page.submitCount).toBe(1);
  });

  it("classifies an exception after the one submit call as uncertain", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    page.submitError = true;

    const result = await runLiveRegistrationAttempt(
      options(store, job.id, page, { send: async () => undefined }),
    );

    expect(result).toMatchObject({
      status: "uncertain",
      job: { state: "uncertain", failureCode: "submission_interrupted" },
    });
    expect(page.submitCount).toBe(1);
  });

  it("honors the kill switch immediately before submission", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    let checks = 0;
    const liveOptions = options(store, job.id, page, {
      send: async () => undefined,
    });
    liveOptions.gate.assertClear = vi.fn(() => {
      checks += 1;
      if (checks >= 5) throw new Error("kill switch");
    });

    const result = await runLiveRegistrationAttempt(liveOptions);

    expect(result).toMatchObject({
      status: "blocked",
      job: { state: "blocked", failureCode: "pre_submission_stopped" },
    });
    expect(page.submitCount).toBe(0);
  });

  it("honors a durable cancellation request before submission", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    page.cartContainsSln = async () => {
      store.cancelJob(job.id);
      return true;
    };

    const result = await runLiveRegistrationAttempt(
      options(store, job.id, page, { send: async () => undefined }),
    );

    expect(result).toMatchObject({
      status: "blocked",
      job: { state: "blocked", failureCode: "pre_submission_stopped" },
    });
    expect(page.submitCount).toBe(0);
  });

  it("stops before submission when the runtime command removes the SLN", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    let targets: readonly string[] = ["12345"];
    page.cartContainsSln = async () => {
      targets = [];
      return true;
    };
    const liveOptions = options(store, job.id, page, {
      send: async () => undefined,
    });

    const result = await runLiveRegistrationAttempt({
      ...liveOptions,
      allowedTargets: () =>
        targets.map((sln) => ({ key: sln, slns: [sln] })),
    });

    expect(result).toMatchObject({
      status: "blocked",
      job: { state: "blocked", failureCode: "pre_submission_stopped" },
    });
    expect(page.submitCount).toBe(0);
  });

  it("does not claim a job when the registration page is not ready", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    page.selectedQuarterText = async () => "Summer 2026";

    await expect(
      runLiveRegistrationAttempt(
        options(store, job.id, page, { send: async () => undefined }),
      ),
    ).resolves.toEqual({
      status: "browser_not_ready",
      pageState: "wrong_quarter",
    });
    expect(store.getJob(job.id)?.state).toBe("queued");
    expect(page.submitCount).toBe(0);
  });

  it("alerts when the persistent UW session requires login", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakeLivePage();
    page.currentUrl = async () =>
      "https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO";
    const send = vi.fn(async () => undefined);

    await expect(
      runLiveRegistrationAttempt(options(store, job.id, page, { send })),
    ).resolves.toEqual({
      status: "browser_not_ready",
      pageState: "login_required",
    });
    expect(send).toHaveBeenCalledWith({
      state: "login_required",
      course: "TEST 101 A",
      sln: "12345",
      slns: ["12345"],
      failureCode: "browser_login_required",
    });
    expect(store.getJob(job.id)?.state).toBe("queued");
  });
});
