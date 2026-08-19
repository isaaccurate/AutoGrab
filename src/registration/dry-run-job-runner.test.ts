import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SQLiteRegistrationJobStore } from "../jobs/sqlite-job-store.js";
import type { TrustedSeatNotification } from "../notifications/notify-uw-parser.js";
import { runRegistrationDryRunJob } from "./dry-run-job-runner.js";
import type { RegistrationPageDriver } from "./uw-registration-page.js";

const directories: string[] = [];
const stores: SQLiteRegistrationJobStore[] = [];

class FakePage implements RegistrationPageDriver {
  value = "";
  fillCount = 0;
  currentUrlCount = 0;

  constructor(
    public url = "https://register.uw.edu/register/#/au26",
    public quarter = "Autumn 2026",
    public visible = true,
    public registered: readonly string[] = [],
    public retainFill = true,
  ) {}

  async currentUrl(): Promise<string> {
    this.currentUrlCount += 1;
    return this.url;
  }

  async selectedQuarterText(): Promise<string | null> {
    return this.quarter;
  }

  async isSlnInputVisible(): Promise<boolean> {
    return this.visible;
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

async function createStore(): Promise<SQLiteRegistrationJobStore> {
  const directory = await mkdtemp(join(tmpdir(), "autograb-dry-run-"));
  directories.push(directory);
  const store = new SQLiteRegistrationJobStore(join(directory, "autograb.sqlite"));
  stores.push(store);
  return store;
}

function notification(): TrustedSeatNotification {
  return {
    sourceUidValidity: "99",
    sourceUid: "101",
    sourceMessageId: "<dry-run@example.test>",
    course: "TEST 101 A",
    sln: "12345",
    receivedAt: new Date("2026-08-18T20:00:00.000Z"),
  };
}

function queue(
  store: SQLiteRegistrationJobStore,
  targetSlns?: readonly string[],
) {
  return store.enqueueValidatedNotification({
    mailboxAccount: "student@gmail.com",
    notification: notification(),
    ...(targetSlns ? { targetSlns } : {}),
    now: new Date("2026-08-18T20:00:01.000Z"),
  }).job;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runRegistrationDryRunJob", () => {
  it("leaves queued work untouched when the browser needs login", async () => {
    const store = await createStore();
    const job = queue(store);
    const guards = vi.fn(async () => undefined);
    const page = new FakePage(
      "https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO",
      "",
      false,
    );

    await expect(
      runRegistrationDryRunJob({
        store,
        page,
        targetQuarter: "au26",
        allowedSlns: ["12345"],
        workerId: "dry_run_test",
        installGuards: guards,
      }),
    ).resolves.toEqual({
      status: "browser_not_ready",
      pageState: "login_required",
    });
    expect(store.getJob(job.id)?.state).toBe("queued");
    expect(guards).not.toHaveBeenCalled();
  });

  it("fills an allowlisted queued SLN and terminates it as safely blocked", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakePage();
    const guards = vi.fn(async () => undefined);

    const result = await runRegistrationDryRunJob({
      store,
      page,
      targetQuarter: "au26",
      allowedSlns: ["12345"],
      workerId: "dry_run_test",
      installGuards: guards,
    });

    expect(result).toMatchObject({
      status: "prepared",
      job: {
        id: job.id,
        state: "blocked",
        failureCode: "dry_run_submission_disabled",
      },
    });
    expect(guards).toHaveBeenCalledOnce();
    expect(page.fillCount).toBe(1);
    expect(page.value).toBe("12345");
  });

  it("blocks a bundle without modifying the single-field dry-run form", async () => {
    const store = await createStore();
    const job = queue(store, ["12345", "54321"]);
    const page = new FakePage();

    await expect(
      runRegistrationDryRunJob({
        store,
        page,
        targetQuarter: "au26",
        allowedSlns: ["12345", "54321"],
        workerId: "dry_run_test",
        installGuards: async () => undefined,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "dry_run_bundle_requires_cart",
      job: { id: job.id, state: "blocked" },
    });
    expect(page.fillCount).toBe(0);
  });

  it("reuses the browser wait result and checks readiness only once after claim", async () => {
    const store = await createStore();
    queue(store);
    const page = new FakePage();

    await runRegistrationDryRunJob({
      store,
      page,
      targetQuarter: "au26",
      allowedSlns: ["12345"],
      workerId: "dry_run_test",
      installGuards: async () => undefined,
      initialPageState: "ready",
    });

    expect(page.currentUrlCount).toBe(1);
  });

  it("marks an already registered SLN as succeeded without filling", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakePage();
    page.registered = ["12345"];

    await expect(
      runRegistrationDryRunJob({
        store,
        page,
        targetQuarter: "au26",
        allowedSlns: ["12345"],
        workerId: "dry_run_test",
        installGuards: async () => undefined,
      }),
    ).resolves.toMatchObject({
      status: "already_registered",
      job: { id: job.id, state: "succeeded" },
    });
    expect(page.fillCount).toBe(0);
  });

  it("blocks a queued SLN removed from the current allowlist", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakePage();

    await expect(
      runRegistrationDryRunJob({
        store,
        page,
        targetQuarter: "au26",
        allowedSlns: ["54321"],
        workerId: "dry_run_test",
        installGuards: async () => undefined,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "sln_not_allowlisted",
      job: { id: job.id, state: "blocked" },
    });
    expect(page.fillCount).toBe(0);
  });

  it("records preparation errors as blocked because no submission API exists", async () => {
    const store = await createStore();
    const job = queue(store);
    const page = new FakePage();
    page.retainFill = false;

    await expect(
      runRegistrationDryRunJob({
        store,
        page,
        targetQuarter: "au26",
        allowedSlns: ["12345"],
        workerId: "dry_run_test",
        installGuards: async () => undefined,
      }),
    ).rejects.toThrow("did not retain");
    expect(store.getJob(job.id)).toMatchObject({
      state: "blocked",
      failureCode: "dry_run_preparation_failed",
    });
  });
});
