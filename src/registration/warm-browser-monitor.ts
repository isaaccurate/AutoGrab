import {
  classifyRegistrationPage,
  type RegistrationPageDriver,
  type RegistrationPageState,
} from "./uw-registration-page.js";

export interface WarmBrowserMonitorOptions {
  readonly page: RegistrationPageDriver;
  readonly targetQuarter: string;
  readonly shouldStop: () => boolean;
  readonly onState: (state: RegistrationPageState) => void;
  readonly onReady: () => void | Promise<void>;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function monitorWarmRegistrationBrowser(
  options: WarmBrowserMonitorOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("The warm-browser poll interval must be positive.");
  }
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let previousState: RegistrationPageState | null = null;

  while (!options.shouldStop()) {
    const state = await classifyRegistrationPage(
      options.page,
      options.targetQuarter,
    );
    if (state !== previousState) {
      previousState = state;
      options.onState(state);
      if (state === "ready") await options.onReady();
    }
    if (!options.shouldStop()) await sleep(pollIntervalMs);
  }
}
