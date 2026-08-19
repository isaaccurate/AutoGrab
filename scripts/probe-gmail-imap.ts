import { ZodError } from "zod";

import { loadConfig } from "../src/config.js";
import { GMAIL_IMAP } from "../src/email/gmail/constants.js";
import {
  GmailImapProbeError,
  probeGmailImap,
} from "../src/email/gmail/imap-probe.js";
import { GoogleOAuthTokenProvider } from "../src/email/gmail/oauth-token-provider.js";
import { FileRefreshTokenStore } from "../src/email/gmail/token-store.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const tokenProvider = new GoogleOAuthTokenProvider({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
    tokenStore: new FileRefreshTokenStore(),
  });

  const result = await probeGmailImap({
    host: config.imapHost,
    port: config.imapPort,
    emailAddress: config.emailAddress,
    mailbox: GMAIL_IMAP.mailbox,
    tokenProvider,
  });

  console.info("OAuth token acquired: yes");
  console.info("TLS connection established: yes");
  console.info("IMAP authenticated: yes");
  console.info("IDLE capability: yes");
  console.info(`Mailbox selected read-only: ${result.mailboxSelected}`);
  console.info("Connection closed cleanly: yes");
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
    console.error(`Invalid configuration: ${invalidFields.join(", ")}.`);
  } else if (error instanceof GmailImapProbeError) {
    console.error(error.message);
  } else {
    console.error("The Gmail IMAP probe failed unexpectedly.");
  }
  process.exitCode = 1;
});
