import { loadConfig } from "./config.js";
import { FileMailboxCursorStore } from "./email/gmail/cursor-store.js";
import { GMAIL_IMAP, NOTIFY_UW } from "./email/gmail/constants.js";
import { GmailIdleListener } from "./email/gmail/idle-listener.js";
import { GoogleOAuthTokenProvider } from "./email/gmail/oauth-token-provider.js";
import { FileRefreshTokenStore } from "./email/gmail/token-store.js";
import { SQLiteRegistrationJobStore } from "./jobs/sqlite-job-store.js";
import { parseNotifyUwNotification } from "./notifications/notify-uw-parser.js";
import { AutomaticRegistrationWorker } from "./registration/automatic-registration-worker.js";
import { LiveRegistrationKillSwitch } from "./registration/live-kill-switch.js";
import { UwPlaywrightBrowser } from "./registration/playwright-browser.js";
import { createDefaultRegistrationAlertSink } from "./registration/registration-alerts.js";
import {
  findRegistrationTarget,
  flattenedTargetSlns,
} from "./registration/registration-target.js";
import { RuntimeTargetSlnStore } from "./registration/runtime-target-store.js";
import { monitorWarmRegistrationBrowser } from "./registration/warm-browser-monitor.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const jobStore = new SQLiteRegistrationJobStore();
  const targetStore = new RuntimeTargetSlnStore();
  const currentTargets = () => targetStore.loadTargets(config.targetSlns);
  const currentTargetSlns = (): readonly string[] =>
    flattenedTargetSlns(currentTargets());
  const recoveredJobCount = jobStore.recoverExpiredRunningJobs();
  if (recoveredJobCount > 0) {
    console.warn("Interrupted registration jobs require review.", {
      uncertainJobCount: recoveredJobCount,
    });
  }
  const tokenProvider = new GoogleOAuthTokenProvider({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
    tokenStore: new FileRefreshTokenStore(),
  });
  const listener = new GmailIdleListener({
    host: config.imapHost,
    port: config.imapPort,
    emailAddress: config.emailAddress,
    mailbox: GMAIL_IMAP.mailbox,
    idleRefreshMs: GMAIL_IMAP.idleRefreshMs,
    allowedSenders: config.allowedSenders,
    maxCandidateBytes: NOTIFY_UW.maxMessageBytes,
    tokenProvider,
    cursorStore: new FileMailboxCursorStore(),
    onStatus: (status) => {
      console.info("Gmail listener status", {
        state: status.state,
        reconnectAttempt: status.reconnectAttempt,
        lastError: status.lastError,
      });
    },
  });
  const killSwitch = new LiveRegistrationKillSwitch();
  let registrationWorker: AutomaticRegistrationWorker | null = null;
  let warmBrowser: UwPlaywrightBrowser | null = null;
  let warmBrowserMonitor: Promise<void> | null = null;

  let shutdownRequested = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.info(`AutoGrab shutdown requested (${signal}).`);
    killSwitch.requestStop();
    void listener.stop().catch(() => undefined);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  console.info("AutoGrab Gmail listener starting.", {
    allowedSenderCount: config.allowedSenders.length,
    registrationMode: config.registrationMode,
    targetSlnCount: currentTargetSlns().length,
  });

  try {
    if (config.registrationMode === "live") {
      warmBrowser = new UwPlaywrightBrowser(config.targetQuarter);
      const warmPage = await warmBrowser.startLive();
      console.info("Warm UW registration browser opened.");
      console.info(
        "Complete UW sign-in manually if requested and keep this browser open.",
      );

      const sharedBrowserSession = {
        startLive: async () => warmPage,
        close: async () => undefined,
      };
      registrationWorker = new AutomaticRegistrationWorker({
        store: jobStore,
        targetQuarter: config.targetQuarter,
        allowedTargets: currentTargets,
        maxJobAgeMs: config.notificationMaxAgeMs,
        alerts: createDefaultRegistrationAlertSink(),
        gate: killSwitch,
        browserFactory: () => sharedBrowserSession,
        onResult: (result, job) => {
          if (result.status === "browser_not_ready") {
            console.info("Automatic registration browser is not ready.", {
              jobId: job.id,
              state: result.pageState,
            });
            if (result.pageState === "login_required") {
              console.info(
                "Complete sign-in in the open warm browser; the queued job will resume when ready.",
              );
            }
            return;
          }
          console.info("Automatic registration attempt finished.", {
            jobId: result.job.id,
            course: result.job.course,
            sln: result.job.sln,
            slns: result.job.slns,
            state: result.job.state,
            failureCode: result.job.failureCode,
          });
        },
        onFailure: (job) => {
          console.error("Automatic registration worker failed safely.", {
            jobId: job.id,
            sln: job.sln,
          });
        },
      });

      const dispatchQueuedJobs = (retryOnce = true): void => {
        if (shutdownRequested || !registrationWorker) return;
        let retryNeeded = false;
        for (const job of jobStore.listQueuedJobs()) {
          if (!registrationWorker.enqueue(job)) retryNeeded = true;
        }
        if (retryOnce && retryNeeded) {
          setTimeout(() => dispatchQueuedJobs(false), 250);
        }
      };
      warmBrowserMonitor = monitorWarmRegistrationBrowser({
        page: warmPage,
        targetQuarter: config.targetQuarter,
        shouldStop: () => shutdownRequested,
        onState: (state) => {
          console.info("Warm UW browser state", { state });
        },
        onReady: () => {
          console.info("Warm UW registration browser is ready.");
          dispatchQueuedJobs();
        },
      }).catch(() => {
        console.error("Warm UW browser monitor stopped safely.");
        if (!shutdownRequested) {
          shutdownRequested = true;
          killSwitch.requestStop();
          void listener.stop().catch(() => undefined);
        }
      });
    }

    await listener.start(async (candidate) => {
      const candidateTargets = currentTargets();
      const result = await parseNotifyUwNotification(candidate, {
        expectedRecipient: config.emailAddress,
        allowedSlns: flattenedTargetSlns(candidateTargets),
        maxAgeMs: config.notificationMaxAgeMs,
        maxMessageBytes: NOTIFY_UW.maxMessageBytes,
      });

      if (!result.accepted) {
        console.info("Candidate email rejected.", {
          uid: candidate.uid,
          reason: result.reason,
        });
        return;
      }

      const queued = jobStore.enqueueValidatedNotification({
        mailboxAccount: config.emailAddress,
        notification: result.notification,
        targetSlns:
          findRegistrationTarget(candidateTargets, result.notification.sln)
            ?.slns ?? [result.notification.sln],
      });

      console.info("Trusted Notify.UW notification stored.", {
        uid: result.notification.sourceUid,
        messageId: result.notification.sourceMessageId,
        jobId: queued.job.id,
        disposition: queued.disposition,
        state: queued.job.state,
        course: queued.job.course,
        sln: queued.job.sln,
        slns: queued.job.slns,
        receivedAt: result.notification.receivedAt.toISOString(),
      });
      registrationWorker?.enqueue(queued.job);
    });
    if (shutdownRequested) console.info("AutoGrab stopped cleanly.");
  } finally {
    shutdownRequested = true;
    await registrationWorker?.stop();
    await warmBrowserMonitor;
    await warmBrowser?.close();
    jobStore.close();
  }
}

main().catch(() => {
  console.error("AutoGrab stopped after a sanitized listener failure.");
  process.exitCode = 1;
});
