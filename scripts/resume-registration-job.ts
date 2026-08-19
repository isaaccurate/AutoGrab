import { loadConfig } from "../src/config.js";
import { SQLiteRegistrationJobStore } from "../src/jobs/sqlite-job-store.js";
import { LiveRegistrationKillSwitch } from "../src/registration/live-kill-switch.js";
import { UwPlaywrightBrowser } from "../src/registration/playwright-browser.js";
import { createDefaultRegistrationAlertSink } from "../src/registration/registration-alerts.js";
import { resumeRegistrationJob } from "../src/registration/resume-registration-job.js";
import { RuntimeTargetSlnStore } from "../src/registration/runtime-target-store.js";
import { waitForRegistrationPageReady } from "../src/registration/uw-registration-page.js";

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestedJobId(args: readonly string[]): string {
  if (args.length !== 1 || !JOB_ID_PATTERN.test(args[0] ?? "")) {
    throw new Error("Usage: npm run job:resume -- <job-id>");
  }
  return args[0]!;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.registrationMode !== "live") {
    throw new Error("The resume command requires live registration mode.");
  }

  const jobId = requestedJobId(process.argv.slice(2));
  const store = new SQLiteRegistrationJobStore();
  const targetStore = new RuntimeTargetSlnStore();
  const allowedTargets = () => targetStore.loadTargets(config.targetSlns);
  const gate = new LiveRegistrationKillSwitch();
  const browser = new UwPlaywrightBrowser(config.targetQuarter);
  const requestStop = (): void => gate.requestStop();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    console.info("Resuming queued registration job.", { jobId });
    console.info("Complete UW sign-in manually in the opened browser if requested.");
    const result = await resumeRegistrationJob({
      store,
      browser,
      alerts: createDefaultRegistrationAlertSink(),
      gate,
      targetQuarter: config.targetQuarter,
      allowedTargets,
      jobId,
      workerId: `resume_${process.pid}`,
      waitUntilReady: (page, targetQuarter) =>
        waitForRegistrationPageReady(page, targetQuarter, {
          timeoutMs: 5 * 60 * 1_000,
        }),
    });

    if (result.status === "browser_not_ready") {
      console.info("Registration job remains queued.", {
        jobId,
        state: result.pageState,
      });
      return;
    }
    console.info("Resumed registration attempt finished.", {
      jobId: result.job.id,
      slns: result.job.slns,
      state: result.job.state,
      failureCode: result.job.failureCode,
    });
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error("Registration job resume failed.", { message });
  process.exitCode = 1;
});
