import { loadConfig } from "../src/config.js";
import { UwPlaywrightBrowser } from "../src/registration/playwright-browser.js";
import { classifyRegistrationPage } from "../src/registration/uw-registration-page.js";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const browser = new UwPlaywrightBrowser(config.targetQuarter);
  const page = await browser.start();
  let stopping = false;
  const requestStop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  console.info("Private UW browser opened.");
  console.info("Complete UW sign-in and MFA manually if requested.");
  let previousState: string | null = null;

  try {
    while (!stopping) {
      const state = await classifyRegistrationPage(page, config.targetQuarter);
      if (state !== previousState) {
        console.info("UW browser state", { state });
        previousState = state;
      }
      if (state === "ready") {
        console.info("UW registration profile is ready. Press Ctrl-C to close it.");
        while (!stopping) await wait(500);
        break;
      }
      await wait(1_000);
    }
  } finally {
    await browser.close();
    console.info("UW browser closed cleanly.");
  }
}

main().catch(() => {
  console.error("UW browser setup stopped after a sanitized failure.");
  process.exitCode = 1;
});
