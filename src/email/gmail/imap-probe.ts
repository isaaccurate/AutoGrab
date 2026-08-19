import { ImapFlow } from "imapflow";

import type { OAuthTokenProvider } from "./oauth-token-provider.js";

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;
const MAILBOX_LOCK_TIMEOUT_MS = 10_000;

interface MailboxLock {
  release(): void;
}

interface SelectedMailbox {
  path: string;
  readOnly?: boolean;
}

interface ImapProbeClient {
  capabilities: Map<string, boolean | number>;
  secureConnection: boolean;
  authenticated: string | boolean;
  mailbox: SelectedMailbox | false;
  connect(): Promise<void>;
  getMailboxLock(
    path: string,
    options: { readOnly: boolean; acquireTimeout: number },
  ): Promise<MailboxLock>;
  logout(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface GmailImapProbeOptions {
  host: string;
  port: number;
  emailAddress: string;
  mailbox: string;
  tokenProvider: OAuthTokenProvider;
  clientFactory?: (accessToken: string) => ImapProbeClient;
}

export interface GmailImapProbeResult {
  tlsEstablished: true;
  authenticated: true;
  idleSupported: true;
  mailboxSelected: string;
  mailboxReadOnly: true;
  disconnectedCleanly: true;
}

type ProbePhase = "token" | "connect" | "capabilities" | "mailbox";

export class GmailImapProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailImapProbeError";
  }
}

function sanitizeProbeError(error: unknown, phase: ProbePhase): GmailImapProbeError {
  if (error instanceof GmailImapProbeError) return error;

  switch (phase) {
    case "token":
      return new GmailImapProbeError(
        "Unable to obtain Gmail access. Run `npm run oauth:gmail` again.",
      );
    case "connect":
      return new GmailImapProbeError(
        "Unable to establish the Gmail IMAP TLS/XOAUTH2 connection.",
      );
    case "capabilities":
      return new GmailImapProbeError(
        "Unable to inspect Gmail IMAP capabilities.",
      );
    case "mailbox":
      return new GmailImapProbeError(
        "Unable to select the Gmail INBOX in read-only mode.",
      );
  }
}

function createImapClient(
  options: GmailImapProbeOptions,
  accessToken: string,
): ImapProbeClient {
  return new ImapFlow({
    host: options.host,
    port: options.port,
    secure: true,
    auth: {
      user: options.emailAddress,
      accessToken,
    },
    clientInfo: {
      name: "AutoGrab",
      version: "0.1.0",
      vendor: "local",
    },
    disableAutoIdle: true,
    logger: false,
    logRaw: false,
    emitLogs: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: {
      minVersion: "TLSv1.2",
      servername: options.host,
    },
  });
}

export async function probeGmailImap(
  options: GmailImapProbeOptions,
): Promise<GmailImapProbeResult> {
  let phase: ProbePhase = "token";
  let client: ImapProbeClient | undefined;
  let lock: MailboxLock | undefined;
  let connected = false;
  let failure: GmailImapProbeError | undefined;
  let result: Omit<GmailImapProbeResult, "disconnectedCleanly"> | undefined;

  try {
    const accessToken = await options.tokenProvider.getAccessToken();
    client =
      options.clientFactory?.(accessToken) ??
      createImapClient(options, accessToken);
    client.on("error", () => {
      // ImapFlow errors are handled through awaited operations and sanitized below.
    });

    phase = "connect";
    await client.connect();
    connected = true;

    if (!client.secureConnection || !client.authenticated) {
      throw new GmailImapProbeError(
        "Gmail did not establish an authenticated TLS session.",
      );
    }

    phase = "capabilities";
    if (!client.capabilities.has("IDLE")) {
      throw new GmailImapProbeError(
        "Gmail connected successfully but did not advertise IMAP IDLE.",
      );
    }

    phase = "mailbox";
    lock = await client.getMailboxLock(options.mailbox, {
      readOnly: true,
      acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
    });

    if (!client.mailbox || client.mailbox.path !== options.mailbox) {
      throw new GmailImapProbeError(
        "Gmail did not select the expected mailbox.",
      );
    }

    if (client.mailbox.readOnly !== true) {
      throw new GmailImapProbeError(
        "Gmail did not confirm that the mailbox is read-only.",
      );
    }

    result = {
      tlsEstablished: true,
      authenticated: true,
      idleSupported: true,
      mailboxSelected: client.mailbox.path,
      mailboxReadOnly: true,
    };
  } catch (error) {
    failure = sanitizeProbeError(error, phase);
  }

  lock?.release();

  if (client) {
    if (connected) {
      try {
        await client.logout();
      } catch {
        client.close();
        failure ??= new GmailImapProbeError(
          "The Gmail IMAP probe completed but could not disconnect cleanly.",
        );
      }
    } else {
      client.close();
    }
  }

  if (failure) throw failure;
  if (!result) {
    throw new GmailImapProbeError(
      "The Gmail IMAP probe ended without a result.",
    );
  }

  return {
    ...result,
    disconnectedCleanly: true,
  };
}
