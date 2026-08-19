import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RegistrationJobState } from "../jobs/sqlite-job-store.js";

const execFileAsync = promisify(execFile);

export interface RegistrationAlert {
  readonly state:
    | Extract<
        RegistrationJobState,
        "succeeded" | "failed" | "uncertain" | "blocked"
      >
    | "login_required";
  readonly course: string;
  readonly sln: string;
  readonly slns: readonly string[];
  readonly failureCode: string | null;
}

export interface RegistrationAlertSink {
  send(alert: RegistrationAlert): Promise<void>;
}

export function alertTitle(alert: RegistrationAlert): string {
  const labels = {
    blocked: "AutoGrab stopped",
    failed: "Registration failed",
    login_required: "UW sign-in required",
    succeeded: "Registration succeeded",
    uncertain: "Registration result uncertain",
  } as const;
  return labels[alert.state];
}

export function alertBody(alert: RegistrationAlert): string {
  const reason = alert.failureCode ? ` (${alert.failureCode})` : "";
  const label = alert.slns.length === 1 ? "SLN" : "SLNs";
  return `${alert.course} · ${label} ${alert.slns.join(" + ")}${reason}`;
}

export class ConsoleRegistrationAlertSink implements RegistrationAlertSink {
  async send(alert: RegistrationAlert): Promise<void> {
    console.info(alertTitle(alert), {
      course: alert.course,
      sln: alert.sln,
      slns: alert.slns,
      state: alert.state,
      failureCode: alert.failureCode,
    });
  }
}

export class MacOsRegistrationAlertSink implements RegistrationAlertSink {
  async send(alert: RegistrationAlert): Promise<void> {
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      alertTitle(alert),
      alertBody(alert),
    ]);
  }
}

export class CompositeRegistrationAlertSink implements RegistrationAlertSink {
  constructor(private readonly sinks: readonly RegistrationAlertSink[]) {}

  async send(alert: RegistrationAlert): Promise<void> {
    const results = await Promise.allSettled(
      this.sinks.map((sink) => sink.send(alert)),
    );
    if (results.every((result) => result.status === "rejected")) {
      throw new Error("Every registration alert channel failed.");
    }
  }
}

export function createDefaultRegistrationAlertSink(): RegistrationAlertSink {
  const consoleSink = new ConsoleRegistrationAlertSink();
  return process.platform === "darwin"
    ? new CompositeRegistrationAlertSink([
        consoleSink,
        new MacOsRegistrationAlertSink(),
      ])
    : consoleSink;
}
