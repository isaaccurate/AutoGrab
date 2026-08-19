import { spawn } from "node:child_process";

import { ZodError } from "zod";

import { loadConfig } from "../src/config.js";
import { authorizeGmail } from "../src/email/gmail/oauth-authorization.js";
import { FileRefreshTokenStore } from "../src/email/gmail/token-store.js";

async function openAuthorizationUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  console.info("Opening Google authorization in your browser…");
  await authorizeGmail({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
    tokenStore: new FileRefreshTokenStore(),
    openAuthorizationUrl,
  });
  console.info("Authorization approved.");
  console.info("Refresh credential stored securely.");
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    const invalidFields = [
      ...new Set(
        error.issues
          .map((issue) => issue.path[0])
          .filter((field): field is string => typeof field === "string"),
      ),
    ];
    console.error(
      `Gmail authorization configuration is invalid: ${invalidFields.join(", ")}.`,
    );
  } else {
    console.error(
      "Gmail authorization failed. Check the OAuth configuration and try again.",
    );
  }
  process.exitCode = 1;
});
