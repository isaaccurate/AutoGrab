import type { Page } from "playwright";

const REGISTRATION_ORIGIN = "https://register.uw.edu";
const LOGIN_HOST = "idp.u.washington.edu";
const QUARTER_PATTERN = /^(?:wi|sp|su|au)\d{2}$/;
const SLN_PATTERN = /^\d{5}$/;

export type RegistrationPageState =
  | "login_required"
  | "ready"
  | "wrong_quarter"
  | "unavailable";

export type DryRunPreparationResult =
  | { readonly status: "prepared"; readonly sln: string }
  | { readonly status: "already_registered"; readonly sln: string }
  | {
      readonly status: Exclude<RegistrationPageState, "ready">;
      readonly sln: string;
    };

export type SlnPreparationResult =
  | { readonly status: "prepared"; readonly sln: string }
  | { readonly status: "already_registered"; readonly sln: string };

export type SlnBundlePreparationResult =
  | { readonly status: "prepared"; readonly slns: readonly string[] }
  | {
      readonly status: "already_registered";
      readonly slns: readonly string[];
    };

export interface RegistrationPageDriver {
  currentUrl(): Promise<string>;
  selectedQuarterText(): Promise<string | null>;
  isSlnInputVisible(): Promise<boolean>;
  registeredSlns(): Promise<readonly string[]>;
  fillSln(sln: string): Promise<void>;
  readSln(): Promise<string>;
}

export interface LiveRegistrationPageDriver extends RegistrationPageDriver {
  addToCart(): Promise<void>;
  cartContainsSln(sln: string): Promise<boolean>;
  submitUpdateSchedule(): Promise<void>;
  registrationMessages(): Promise<readonly string[]>;
}

export interface RegistrationPageWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function registrationUrl(targetQuarter: string): string {
  assertQuarter(targetQuarter);
  return `${REGISTRATION_ORIGIN}/register/#/${targetQuarter}`;
}

export function expectedQuarterLabel(targetQuarter: string): string {
  assertQuarter(targetQuarter);
  const names: Readonly<Record<string, string>> = {
    au: "Autumn",
    sp: "Spring",
    su: "Summer",
    wi: "Winter",
  };
  const prefix = targetQuarter.slice(0, 2);
  const year = targetQuarter.slice(2);
  return `${names[prefix]} 20${year}`;
}

function assertQuarter(targetQuarter: string): void {
  if (!QUARTER_PATTERN.test(targetQuarter)) {
    throw new Error("The target quarter is invalid.");
  }
}

function routeQuarter(url: URL): string | null {
  return /^#\/((?:wi|sp|su|au)\d{2})(?:[?/#]|$)/.exec(url.hash)?.[1] ?? null;
}

export async function classifyRegistrationPage(
  page: RegistrationPageDriver,
  targetQuarter: string,
): Promise<RegistrationPageState> {
  assertQuarter(targetQuarter);
  try {
    const url = new URL(await page.currentUrl());

    if (url.hostname === LOGIN_HOST) return "login_required";
    if (url.origin !== REGISTRATION_ORIGIN || url.pathname !== "/register/") {
      return "unavailable";
    }
    if (routeQuarter(url) !== targetQuarter) return "wrong_quarter";
    if ((await page.selectedQuarterText()) !== expectedQuarterLabel(targetQuarter)) {
      return "wrong_quarter";
    }
    return (await page.isSlnInputVisible()) ? "ready" : "unavailable";
  } catch {
    // Register.UW is a single-page app. Playwright reads can briefly fail while
    // navigation replaces the document, so treat them as a retryable state.
    return "unavailable";
  }
}

export async function waitForRegistrationPageReady(
  page: RegistrationPageDriver,
  targetQuarter: string,
  options: RegistrationPageWaitOptions = {},
): Promise<RegistrationPageState> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  if (timeoutMs < 0 || pollIntervalMs <= 0) {
    throw new Error("Registration page wait intervals are invalid.");
  }

  const startedAt = now();
  let state = await classifyRegistrationPage(page, targetQuarter);
  while (state !== "ready" && now() - startedAt < timeoutMs) {
    await sleep(Math.min(pollIntervalMs, timeoutMs - (now() - startedAt)));
    state = await classifyRegistrationPage(page, targetQuarter);
  }
  return state;
}

export async function prepareRegistrationDryRun(
  page: RegistrationPageDriver,
  targetQuarter: string,
  sln: string,
): Promise<DryRunPreparationResult> {
  if (!SLN_PATTERN.test(sln)) {
    throw new Error("The dry-run SLN must contain exactly five digits.");
  }
  const state = await classifyRegistrationPage(page, targetQuarter);
  if (state !== "ready") return { status: state, sln };

  return prepareSlnForCart(page, sln);
}

export async function prepareSlnForCart(
  page: RegistrationPageDriver,
  sln: string,
): Promise<SlnPreparationResult> {
  const result = await prepareSlnsForCart(page, [sln]);
  return { status: result.status, sln };
}

export async function prepareSlnsForCart(
  page: RegistrationPageDriver,
  slns: readonly string[],
): Promise<SlnBundlePreparationResult> {
  if (slns.length === 0 || !slns.every((sln) => SLN_PATTERN.test(sln))) {
    throw new Error("Every registration SLN must contain exactly five digits.");
  }

  const registered = await page.registeredSlns();
  const missing = [...new Set(slns)].filter(
    (sln) => !registered.includes(sln),
  );
  if (missing.length === 0) {
    return { status: "already_registered", slns: [] };
  }

  await page.fillSln(missing.join(" "));
  const retained = (await page.readSln())
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (
    retained.length !== missing.length ||
    retained.some((sln, index) => sln !== missing[index])
  ) {
    throw new Error("The registration form did not retain the expected SLNs.");
  }
  return { status: "prepared", slns: missing };
}

export class PlaywrightRegistrationPage implements RegistrationPageDriver {
  constructor(private readonly page: Page) {}

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async selectedQuarterText(): Promise<string | null> {
    const selector = this.page.getByRole("combobox", {
      name: "Select a Quarter for Registration",
      exact: true,
    });
    if ((await selector.count()) !== 1) return null;
    return selector.locator("option:checked").textContent();
  }

  async isSlnInputVisible(): Promise<boolean> {
    const input = this.slnInput();
    return (await input.count()) === 1 && input.isVisible();
  }

  async registeredSlns(): Promise<readonly string[]> {
    const values = await this.page.getByRole("rowheader").allTextContents();
    return values.flatMap((value) => {
      const sln = /^\s*(\d{5})/.exec(value)?.[1];
      return sln ? [sln] : [];
    });
  }

  async fillSln(sln: string): Promise<void> {
    await this.slnInput().fill(sln);
  }

  async readSln(): Promise<string> {
    return this.slnInput().inputValue();
  }

  private slnInput() {
    return this.page.getByRole("textbox", {
      name: "Enter SLN to add to cart",
      exact: true,
    });
  }
}

export class PlaywrightLiveRegistrationPage
  implements LiveRegistrationPageDriver
{
  private readonly base: PlaywrightRegistrationPage;

  constructor(private readonly page: Page) {
    this.base = new PlaywrightRegistrationPage(page);
  }

  currentUrl(): Promise<string> {
    return this.base.currentUrl();
  }

  selectedQuarterText(): Promise<string | null> {
    return this.base.selectedQuarterText();
  }

  isSlnInputVisible(): Promise<boolean> {
    return this.base.isSlnInputVisible();
  }

  registeredSlns(): Promise<readonly string[]> {
    return this.base.registeredSlns();
  }

  fillSln(sln: string): Promise<void> {
    return this.base.fillSln(sln);
  }

  readSln(): Promise<string> {
    return this.base.readSln();
  }

  async addToCart(): Promise<void> {
    await (await this.uniqueButton("Add to cart")).click();
  }

  async cartContainsSln(sln: string): Promise<boolean> {
    const occurrences = await this.page.getByText(sln, { exact: false }).allTextContents();
    return occurrences.some((text) =>
      new RegExp(`(?:^|\\D)${sln}(?:\\D|$)`).test(text),
    );
  }

  async submitUpdateSchedule(): Promise<void> {
    await (await this.uniqueButton("Update Schedule")).click();
  }

  async registrationMessages(): Promise<readonly string[]> {
    const messages = await Promise.all([
      this.page.getByRole("alert").allTextContents(),
      this.page.getByRole("status").allTextContents(),
    ]);
    return [...new Set(messages.flat().map((value) => value.trim()).filter(Boolean))];
  }

  private async uniqueButton(name: string) {
    const button = this.page.getByRole("button", { name, exact: true });
    if ((await button.count()) !== 1 || !(await button.isEnabled())) {
      throw new Error(`The ${name} action is not uniquely available.`);
    }
    return button;
  }
}
