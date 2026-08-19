import type { BrowserContext, Page, Route } from "playwright";

import {
  defaultPlaywrightBrowsersPath,
  defaultUwBrowserProfilePath,
  ensurePrivateDirectory,
} from "./browser-paths.js";
import {
  PlaywrightLiveRegistrationPage,
  PlaywrightRegistrationPage,
  registrationUrl,
} from "./uw-registration-page.js";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BLOCKED_REGISTRATION_ACTIONS = new Set(["Add to cart", "Update Schedule"]);

export function isReadOnlyRequestMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method.toUpperCase());
}

export function isBlockedRegistrationAction(label: string): boolean {
  return BLOCKED_REGISTRATION_ACTIONS.has(label.trim());
}

export function dryRunDomGuardScript(
  blockedLabels: readonly string[],
): string {
  const labels = JSON.stringify(blockedLabels);
  return `(() => {
    const labels = new Set(${labels});
    const normalizedLabel = (element) =>
      (element.textContent || "").replace(/\\s+/g, " ").trim();
    const disableActions = () => {
      for (const button of document.querySelectorAll("button")) {
        if (labels.has(normalizedLabel(button))) {
          button.disabled = true;
          button.setAttribute("aria-disabled", "true");
          button.dataset.autograbDryRunBlocked = "true";
        }
      }
    };
    disableActions();
    new MutationObserver(disableActions).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element ? target.closest("button") : null;
      if (button && labels.has(normalizedLabel(button))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  })()`;
}

export class UwPlaywrightBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private dryRunGuardInstalled = false;

  constructor(
    private readonly targetQuarter: string,
    private readonly profilePath = defaultUwBrowserProfilePath(),
    private readonly browsersPath = defaultPlaywrightBrowsersPath(),
  ) {}

  async start(): Promise<PlaywrightRegistrationPage> {
    return new PlaywrightRegistrationPage(await this.startPage());
  }

  async startLive(): Promise<PlaywrightLiveRegistrationPage> {
    return new PlaywrightLiveRegistrationPage(await this.startPage());
  }

  private async startPage(): Promise<Page> {
    if (this.context || this.page) {
      throw new Error("The UW browser is already running.");
    }
    ensurePrivateDirectory(this.profilePath);
    ensurePrivateDirectory(this.browsersPath);
    process.env.PLAYWRIGHT_BROWSERS_PATH = this.browsersPath;
    const { chromium } = await import("playwright");
    this.context = await chromium.launchPersistentContext(this.profilePath, {
      acceptDownloads: false,
      headless: false,
      serviceWorkers: "block",
      viewport: null,
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    const destination = registrationUrl(this.targetQuarter);
    if (!this.page.url().startsWith(destination)) {
      await this.page.goto(destination, { waitUntil: "domcontentloaded" });
    }
    return this.page;
  }

  async installDryRunGuards(): Promise<void> {
    if (!this.context || !this.page) {
      throw new Error("The UW browser is not running.");
    }
    if (this.dryRunGuardInstalled) return;
    const addButton = this.page.getByRole("button", {
      name: "Add to cart",
      exact: true,
    });
    const updateButton = this.page.getByRole("button", {
      name: "Update Schedule",
      exact: true,
    });
    if ((await addButton.count()) !== 1 || (await updateButton.count()) !== 1) {
      throw new Error("The expected registration actions were not found.");
    }

    await this.context.route("**/*", async (route: Route) => {
      if (isReadOnlyRequestMethod(route.request().method())) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    await this.page.evaluate(
      dryRunDomGuardScript([...BLOCKED_REGISTRATION_ACTIONS]),
    );
    this.dryRunGuardInstalled = true;
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.dryRunGuardInstalled = false;
    await context?.close();
  }
}
