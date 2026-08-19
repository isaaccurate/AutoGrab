import { EventEmitter } from "node:events";

import { ImapFlow } from "imapflow";

// Import email contracts for type checking only(removed from the emitted JavaScript)
import type {
  CandidateEmail,
  CandidateEmailHandler,
  EmailListener,
  MailboxCursor,
  MailboxCursorStore,
} from "../types.js";

// Describes the OAuth token provider used to authenticate the IMAP connection.
import type { OAuthTokenProvider } from "./oauth-token-provider.js";

// Import the runtime reconnect delay and the type-only listener status together.
import {
  reconnectDelayMs,
  type ListenerStatus,
} from "./listener-state.js";

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;
const MAILBOX_LOCK_TIMEOUT_MS = 10_000;

/** Describes the selected mailbox state returned by the IMAP client. */
interface MailboxState {
  // The selected mailbox path, such as "INBOX".
  path: string;
  // Identifies the current version of the mailbox's UID numbering.
  uidValidity: bigint;
  // The next UID the server will assign to a newly added message.
  uidNext: number;
  // Indicates whether mailbox operations are restricted to read-only access.
  readOnly?: boolean;
}

interface MailboxLock {
  // Releases the mailbox lock so other operations can access the mailbox.
  release(): void;
}

/** Contains the message data requested from the IMAP server. */
interface FetchedMessage {
  // Message UID.
  uid: number;
  // Message size in bytes.
  size?: number;
  // Raw message content, optionally limited by the fetch request.
  source?: Buffer;
  // The message's server timestamp, which may be returned as a Date or string.
  internalDate?: Date | string;
  // Envelope metadata used to identify and describe candidate messages.
  envelope?: {
    // Date from the message envelope.
    date?: Date;
    // Subject line from the message envelope.
    subject?: string;
    // Message-ID header value.
    messageId?: string;
    // Sender addresses listed in the message envelope.
    from?: Array<{ address?: string }>;
  };
}

/**
 * Describes the IMAP client used to connect to Gmail, monitor mailbox changes,
 * and fetch newly received messages.
 */
export interface GmailIdleClient extends EventEmitter {
  // Capabilities advertised by the IMAP server, such as IDLE support.
  capabilities: Map<string, boolean | number>;
  // Indicates whether the IMAP connection is using TLS.
  secureConnection: boolean;
  // Indicates whether the client has authenticated, including the account name when available.
  authenticated: string | boolean;
  // The currently selected mailbox, or false when no mailbox is selected.
  mailbox: MailboxState | false;

  // Establishes the IMAP connection and authenticates the client.
  connect(): Promise<void>;

  // Selects a mailbox and returns a lock.
  getMailboxLock(
    path: string,
    options: { readOnly: boolean; acquireTimeout: number; description: string },
  ): Promise<MailboxLock>;

  // Searches for message UIDs matching the supplied IMAP query.
  search(
    query: { uid: string },
    options: { uid: true },
  ): Promise<number[] | false>;

  // Fetches metadata and optionally raw content for one message UID.
  fetchOne(
    uid: string,
    query: {
      uid?: true;
      envelope?: true;
      internalDate?: true;
      size?: true;
      source?: true | { maxLength: number };
    },
    options: { uid: true },
  ): Promise<FetchedMessage | false>;

  // Waits for mailbox changes through the IMAP IDLE command.
  idle(): Promise<boolean | undefined>;

  // Ends the authenticated IMAP session gracefully.
  logout(): Promise<void>;
  
  // Force-closes the underlying connection.
  close(): void;
}

/** Configures the Gmail listener connection, filtering, persistence, and hooks. */
export interface GmailIdleListenerOptions {
  host: string;
  port: number;
  emailAddress: string;
  mailbox: string;
  idleRefreshMs: number;
  allowedSenders: readonly string[];
  maxCandidateBytes: number;
  tokenProvider: OAuthTokenProvider;
  cursorStore: MailboxCursorStore;
  clientFactory?: (accessToken: string) => GmailIdleClient;
  sleep?: (milliseconds: number) => Promise<void>;
  onStatus?: (status: ListenerStatus) => void;
}

type SessionEnd = "closed" | "failed" | "stopped";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function normalizedDate(value: Date | string | undefined): Date {
  const date = value instanceof Date ? value : new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createClient(
  options: GmailIdleListenerOptions,
  accessToken: string,
): GmailIdleClient {
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
    autoIdleDelay: 0,
    maxIdleTime: options.idleRefreshMs,
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

export class GmailIdleListener implements EmailListener {
  private status: ListenerStatus = {
    state: "stopped",
    changedAt: new Date(),
    reconnectAttempt: 0,
    lastEventAt: null,
    lastError: null,
  };
  private runner: Promise<void> | undefined;
  private stopping = false;
  private runStopSignal: ReturnType<typeof createDeferred<void>> | undefined;
  private sessionSignal:
    | ReturnType<typeof createDeferred<SessionEnd>>
    | undefined;

  constructor(private readonly options: GmailIdleListenerOptions) {}

  getStatus(): ListenerStatus {
    return this.status;
  }

  start(onCandidate: CandidateEmailHandler): Promise<void> {
    if (this.runner) {
      throw new Error("The Gmail listener is already running.");
    }

    this.stopping = false;
    this.runStopSignal = createDeferred<void>();
    this.runner = this.run(onCandidate).finally(() => {
      this.runner = undefined;
      this.runStopSignal = undefined;
      this.setStatus("stopped", 0, null);
    });
    return this.runner;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.runStopSignal?.resolve();
    this.sessionSignal?.resolve("stopped");
    await this.runner;
  }

  private async run(onCandidate: CandidateEmailHandler): Promise<void> {
    let reconnectAttempt = 0;

    while (!this.stopping) {
      try {
        await this.runSession(onCandidate, reconnectAttempt, () => {
          reconnectAttempt = 0;
        });
        reconnectAttempt = 0;
      } catch {
        if (this.stopping) break;

        const delay = reconnectDelayMs(reconnectAttempt);
        this.setStatus(
          "backing-off",
          reconnectAttempt + 1,
          "Gmail listener session failed; reconnect scheduled.",
        );
        reconnectAttempt += 1;
        await Promise.race([
          (this.options.sleep ?? defaultSleep)(delay),
          this.runStopSignal?.promise ?? Promise.resolve(),
        ]);
      }
    }
  }

  private async runSession(
    onCandidate: CandidateEmailHandler,
    reconnectAttempt: number,
    onReady: () => void,
  ): Promise<void> {
    this.setStatus("authenticating", reconnectAttempt, null);
    const accessToken = await this.options.tokenProvider.getAccessToken();
    const client =
      this.options.clientFactory?.(accessToken) ??
      createClient(this.options, accessToken);
    const signal = createDeferred<SessionEnd>();
    this.sessionSignal = signal;
    let connected = false;
    let acceptingEvents = true;
    let reconcileRequested = false;
    let reconcileWorker: Promise<void> | undefined;

    const requestReconcile = (): void => {
      if (!acceptingEvents) return;
      reconcileRequested = true;
      if (reconcileWorker) return;

      reconcileWorker = (async () => {
        while (reconcileRequested && acceptingEvents) {
          reconcileRequested = false;
          await this.withMailboxLock(client, (mailbox) =>
            this.reconcile(client, mailbox, onCandidate),
          );
        }
      })()
        .catch(() => signal.resolve("failed"))
        .finally(() => {
          reconcileWorker = undefined;
          if (reconcileRequested && acceptingEvents) {
            queueMicrotask(requestReconcile);
          }
        });
    };

    client.on("error", () => signal.resolve("failed"));
    client.on("close", () => signal.resolve("closed"));
    client.on("exists", () => {
      this.status = { ...this.status, lastEventAt: new Date() };
      requestReconcile();
    });

    try {
      this.setStatus("connecting", reconnectAttempt, null);
      await client.connect();
      connected = true;

      if (
        !client.secureConnection ||
        !client.authenticated ||
        !client.capabilities.has("IDLE")
      ) {
        throw new Error("Gmail IMAP prerequisites were not met.");
      }

      this.setStatus("reconciling", reconnectAttempt, null);
      await this.withMailboxLock(client, (mailbox) =>
        this.reconcile(client, mailbox, onCandidate),
      );

      onReady();
      this.setStatus("idling", 0, null);
      void client.idle().then((succeeded) => {
        if (succeeded === false) signal.resolve("failed");
      }).catch(() => signal.resolve("failed"));

      const end = await signal.promise;
      if (end !== "stopped" && !this.stopping) {
        throw new Error("Gmail IMAP connection ended.");
      }
    } finally {
      acceptingEvents = false;
      reconcileRequested = false;
      await reconcileWorker?.catch(() => undefined);

      if (connected) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      } else {
        client.close();
      }

      if (this.sessionSignal === signal) this.sessionSignal = undefined;
    }
  }

  private async withMailboxLock<T>(
    client: GmailIdleClient,
    operation: (mailbox: MailboxState) => Promise<T>,
  ): Promise<T> {
    const lock = await client.getMailboxLock(this.options.mailbox, {
      readOnly: true,
      acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      description: "AutoGrab Gmail reconciliation",
    });

    try {
      if (!client.mailbox || client.mailbox.readOnly !== true) {
        throw new Error("Gmail INBOX was not selected read-only.");
      }
      return await operation(client.mailbox);
    } finally {
      lock.release();
    }
  }

  private async reconcile(
    client: GmailIdleClient,
    mailbox: MailboxState,
    onCandidate: CandidateEmailHandler,
  ): Promise<void> {
    const uidValidity = mailbox.uidValidity.toString();
    const initialBaselineUid = Math.max(0, mailbox.uidNext - 1);
    let cursor = await this.options.cursorStore.load();

    if (!cursor || cursor.uidValidity !== uidValidity) {
      cursor = {
        uidValidity,
        lastProcessedUid: String(initialBaselineUid),
      };
      await this.options.cursorStore.save(cursor);
      return;
    }

    const lastProcessedUid = Number(cursor.lastProcessedUid);
    const searchResult = await client.search(
      { uid: `${lastProcessedUid + 1}:*` },
      { uid: true },
    );
    const pendingUids = [...new Set(searchResult || [])]
      .filter((uid) => Number.isSafeInteger(uid) && uid > lastProcessedUid)
      .sort((left, right) => left - right);

    for (const uid of pendingUids) {
      const message = await client.fetchOne(
        String(uid),
        {
          uid: true,
          envelope: true,
          internalDate: true,
          size: true,
          source: { maxLength: this.options.maxCandidateBytes + 1 },
        },
        { uid: true },
      );

      if (message) {
        const from = (message.envelope?.from ?? [])
          .map((address) => address.address?.trim().toLowerCase())
          .filter((address): address is string => Boolean(address));
        const isCandidate = from.some((address) =>
          this.options.allowedSenders.some(
            (allowed) => allowed.trim().toLowerCase() === address,
          ),
        );

        if (isCandidate) {
          const rawSource =
            message.size !== undefined &&
            message.size <= this.options.maxCandidateBytes &&
            message.source &&
            message.source.byteLength <= this.options.maxCandidateBytes
              ? message.source
              : null;

          const candidate: CandidateEmail = {
            uidValidity,
            uid: String(message.uid),
            messageId: message.envelope?.messageId ?? null,
            from,
            subject: message.envelope?.subject ?? null,
            receivedAt: normalizedDate(
              message.internalDate ?? message.envelope?.date,
            ),
            size: message.size ?? null,
            rawSource,
          };
          await onCandidate(candidate);
        }
      }

      const nextCursor: MailboxCursor = {
        uidValidity,
        lastProcessedUid: String(uid),
      };
      await this.options.cursorStore.save(nextCursor);
      cursor = nextCursor;
    }
  }

  private setStatus(
    state: ListenerStatus["state"],
    reconnectAttempt: number,
    lastError: string | null,
  ): void {
    this.status = {
      ...this.status,
      state,
      changedAt: new Date(),
      reconnectAttempt,
      lastError,
    };
    this.options.onStatus?.(this.status);
  }
}
