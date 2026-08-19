import { loadConfig } from "../src/config.js";
import { SQLiteRegistrationJobStore } from "../src/jobs/sqlite-job-store.js";
import { runRegistrationDryRunJob } from "../src/registration/dry-run-job-runner.js";
import { UwPlaywrightBrowser } from "../src/registration/playwright-browser.js";
import { waitForRegistrationPageReady } from "../src/registration/uw-registration-page.js";
import { RuntimeTargetSlnStore } from "../src/registration/runtime-target-store.js";

function waitForStop(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.registrationMode !== "dry-run") {
    throw new Error("The Milestone 6 worker requires dry-run mode.");
  }

  const browser = new UwPlaywrightBrowser(config.targetQuarter);
  const store = new SQLiteRegistrationJobStore();
  const targetSlns = new RuntimeTargetSlnStore().load(config.targetSlns);

  try {
    const page = await browser.start();
    console.info("Waiting for the UW registration page to stabilize.");
    const pageState = await waitForRegistrationPageReady(
      page,
      config.targetQuarter,
    );
    if (pageState !== "ready") {
      console.info("UW registration browser is not ready.", {
        state: pageState,
      });
      console.info("Run npm run browser:setup before the dry-run worker.");
      return;
    }

    const result = await runRegistrationDryRunJob({
      store,
      page,
      targetQuarter: config.targetQuarter,
      allowedSlns: targetSlns,
      workerId: `dry_run_${process.pid}`,
      installGuards: () => browser.installDryRunGuards(),
      initialPageState: pageState,
    });

    if (result.status === "browser_not_ready") {
      console.info("UW registration browser is not ready.", {
        state: result.pageState,
      });
      console.info("Run npm run browser:setup before the dry-run worker.");
      return;
    }
    if (result.status === "no_job") {
      console.info("No queued registration job is available for dry run.");
      return;
    }
    if (result.status === "already_registered") {
      console.info("Registration job already satisfied.", {
        jobId: result.job.id,
      });
      return;
    }
    if (result.status === "blocked") {
      console.info("Dry-run job blocked safely.", {
        jobId: result.job.id,
        reason: result.reason,
      });
      return;
    }

    console.info("Dry run prepared the allowlisted SLN without submission.", {
      jobId: result.job.id,
      course: result.job.course,
      sln: result.job.sln,
    });
    console.info("Review the visible form, then press Ctrl-C to close the browser.");
    await waitForStop();
  } finally {
    store.close();
    await browser.close();
  }
}

main().catch(() => {
  console.error("Registration dry run stopped after a sanitized failure.");
  process.exitCode = 1;
});
