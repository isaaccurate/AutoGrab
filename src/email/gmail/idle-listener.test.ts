import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type {
  CandidateEmail,
  MailboxCursor,
  MailboxCursorStore,
} from "../types.js";
import {
  GmailIdleListener,
  type GmailIdleClient,
  type GmailIdleListenerOptions,
} from "./idle-listener.js";

const ALLOWED_SENDER = "notify-noreply@uw.edu";

class MemoryCursorStore implements MailboxCursorStore {
  readonly saves: MailboxCursor[] = [];

  constructor(public cursor: MailboxCursor | null) {}

  async load(): Promise<MailboxCursor | null> {
    return this.cursor;
  }

  async save(cursor: MailboxCursor): Promise<void> {
    this.cursor = cursor;
    this.saves.push(cursor);
  }
}

class FakeIdleClient extends EventEmitter implements GmailIdleClient {
  capabilities = new Map<string, boolean | number>([["IDLE", true]]);
  secureConnection = true;
  authenticated: string | boolean = "student@gmail.com";
  mailbox: GmailIdleClient["mailbox"] = {
    path: "INBOX",
    uidValidity: 99n,
    uidNext: 101,
    readOnly: true,
  };
  readonly connect = vi.fn(async () => undefined);
  readonly logout = vi.fn(async () => {
    this.resolveIdle?.(undefined);
  });
  readonly close = vi.fn(() => {
    this.resolveIdle?.(undefined);
  });
  readonly getMailboxLock = vi.fn(async () => ({
    release: vi.fn(),
  }));
  readonly search = vi.fn(async () => this.searchResults.shift() ?? []);
  readonly fetchOne = vi.fn(
    async (uid: string, query: { source?: true | { maxLength: number } }) => {
      const message = this.messages.get(Number(uid));
      if (!message) return false;
      return query.source
        ? { ...message, source: Buffer.from(`raw-message-${uid}`) }
        : message;
    },
  );
  readonly idle = vi.fn(
    () =>
      new Promise<boolean | undefined>((resolve) => {
        this.resolveIdle = resolve;
      }),
  );
  readonly searchResults: number[][] = [];
  readonly messages = new Map<
    number,
    {
      uid: number;
      size: number;
      internalDate: Date;
      envelope: {
        date: Date;
        subject: string;
        messageId: string;
        from: Array<{ address: string }>;
      };
    }
  >();
  private resolveIdle: ((value: boolean | undefined) => void) | undefined;
}

function addMessage(
  client: FakeIdleClient,
  uid: number,
  sender = ALLOWED_SENDER,
): void {
  const receivedAt = new Date(`2026-08-18T20:${String(uid % 60).padStart(2, "0")}:00Z`);
  client.messages.set(uid, {
    uid,
    size: 1_024 + uid,
    internalDate: receivedAt,
    envelope: {
      date: receivedAt,
      subject: `Notify.UW: TEST ${uid} has seats available`,
      messageId: `<message-${uid}@example.test>`,
      from: [{ address: sender }],
    },
  });
}

function createOptions(
  cursorStore: MailboxCursorStore,
  clients: FakeIdleClient[],
) {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "access-token"),
  };
  const clientFactory = vi.fn(() => {
    const client = clients.shift();
    if (!client) throw new Error("No fake client available.");
    return client;
  });
  const options: GmailIdleListenerOptions = {
    host: "imap.gmail.com",
    port: 993,
    emailAddress: "student@gmail.com",
    mailbox: "INBOX",
    idleRefreshMs: 25 * 60 * 1_000,
    allowedSenders: [ALLOWED_SENDER],
    maxCandidateBytes: 256 * 1_024,
    tokenProvider,
    cursorStore,
    clientFactory,
    sleep: async () => undefined,
  };

  return { options, tokenProvider, clientFactory };
}

async function waitUntilIdling(listener: GmailIdleListener): Promise<void> {
  await vi.waitFor(() => {
    expect(listener.getStatus().state).toBe("idling");
  });
}

describe("GmailIdleListener", () => {
  it("establishes a first-run baseline without replaying old mail", async () => {
    const cursorStore = new MemoryCursorStore(null);
    const client = new FakeIdleClient();
    client.mailbox = {
      path: "INBOX",
      uidValidity: 99n,
      uidNext: 121,
      readOnly: true,
    };
    const { options } = createOptions(cursorStore, [client]);
    const listener = new GmailIdleListener(options);
    const handler = vi.fn();
    const running = listener.start(handler);

    await waitUntilIdling(listener);
    await listener.stop();
    await running;

    expect(cursorStore.cursor).toEqual({
      uidValidity: "99",
      lastProcessedUid: "120",
    });
    expect(client.search).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("processes twenty controlled messages once and in UID order", async () => {
    const cursorStore = new MemoryCursorStore({
      uidValidity: "99",
      lastProcessedUid: "100",
    });
    const client = new FakeIdleClient();
    const uids = Array.from({ length: 20 }, (_, index) => 101 + index);
    client.searchResults.push([...uids].reverse());
    uids.forEach((uid) => addMessage(client, uid));
    const { options } = createOptions(cursorStore, [client]);
    const listener = new GmailIdleListener(options);
    const received: CandidateEmail[] = [];
    const running = listener.start(async (candidate) => {
      received.push(candidate);
    });

    await waitUntilIdling(listener);
    await listener.stop();
    await running;

    expect(received.map((message) => message.uid)).toEqual(
      uids.map(String),
    );
    expect(received.every((message) => message.uidValidity === "99")).toBe(true);
    expect(received.every((message) => message.rawSource instanceof Buffer)).toBe(
      true,
    );
    expect(cursorStore.cursor?.lastProcessedUid).toBe("120");
    expect(cursorStore.saves).toHaveLength(20);
    expect(client.fetchOne).toHaveBeenCalledTimes(20);
    expect(client.fetchOne.mock.calls[0]?.[1]).toMatchObject({
      envelope: true,
      internalDate: true,
      size: true,
      source: { maxLength: 256 * 1_024 + 1 },
    });
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it("breaks IDLE to reconcile a new arrival", async () => {
    const cursorStore = new MemoryCursorStore({
      uidValidity: "99",
      lastProcessedUid: "100",
    });
    const client = new FakeIdleClient();
    client.searchResults.push([], [101]);
    addMessage(client, 101);
    const { options } = createOptions(cursorStore, [client]);
    const listener = new GmailIdleListener(options);
    const handler = vi.fn(async (_candidate: CandidateEmail) => undefined);
    const running = listener.start(handler);

    await waitUntilIdling(listener);
    client.emit("exists", { path: "INBOX", count: 1, prevCount: 0 });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await listener.stop();
    await running;

    expect(handler.mock.calls[0]?.[0].uid).toBe("101");
    expect(client.getMailboxLock).toHaveBeenCalledTimes(2);
    expect(listener.getStatus().state).toBe("stopped");
  });

  it("uses one bounded fetch and rejects a sender-prefilter miss", async () => {
    const cursorStore = new MemoryCursorStore({
      uidValidity: "99",
      lastProcessedUid: "100",
    });
    const client = new FakeIdleClient();
    client.searchResults.push([101]);
    addMessage(client, 101, "someone@example.com");
    const { options } = createOptions(cursorStore, [client]);
    const listener = new GmailIdleListener(options);
    const handler = vi.fn(async (_candidate: CandidateEmail) => undefined);
    const running = listener.start(handler);

    await waitUntilIdling(listener);
    await listener.stop();
    await running;

    expect(handler).not.toHaveBeenCalled();
    expect(client.fetchOne).toHaveBeenCalledOnce();
    expect(client.fetchOne.mock.calls[0]?.[1]).toMatchObject({
      source: { maxLength: 256 * 1_024 + 1 },
    });
    expect(cursorStore.cursor?.lastProcessedUid).toBe("101");
  });

  it("keeps an oversized candidate bounded in the merged fetch", async () => {
    const cursorStore = new MemoryCursorStore({
      uidValidity: "99",
      lastProcessedUid: "100",
    });
    const client = new FakeIdleClient();
    client.searchResults.push([101]);
    addMessage(client, 101);
    const message = client.messages.get(101);
    if (!message) throw new Error("The test message is missing.");
    message.size = 256 * 1_024 + 1;
    const { options } = createOptions(cursorStore, [client]);
    const listener = new GmailIdleListener(options);
    const handler = vi.fn(async (_candidate: CandidateEmail) => undefined);
    const running = listener.start(handler);

    await waitUntilIdling(listener);
    await listener.stop();
    await running;

    expect(client.fetchOne).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "101", rawSource: null }),
    );
    expect(cursorStore.cursor?.lastProcessedUid).toBe("101");
  });

  it("snapshots first-run UIDNEXT before awaiting cursor storage", async () => {
    let releaseLoad!: () => void;
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const saves: MailboxCursor[] = [];
    const cursorStore: MailboxCursorStore = {
      load: async () => {
        markLoadStarted();
        await loadGate;
        return null;
      },
      save: async (cursor) => {
        saves.push(cursor);
      },
    };
    const client = new FakeIdleClient();
    client.mailbox = {
      path: "INBOX",
      uidValidity: 99n,
      uidNext: 101,
      readOnly: true,
    };
    const { options } = createOptions(cursorStore, [client]);
    const listener = new GmailIdleListener(options);
    const running = listener.start(async () => undefined);

    await loadStarted;
    if (client.mailbox) client.mailbox.uidNext = 102;
    releaseLoad();
    await waitUntilIdling(listener);
    await listener.stop();
    await running;

    expect(saves[0]).toEqual({
      uidValidity: "99",
      lastProcessedUid: "100",
    });
  });

  it("recovers a message that arrived during a disconnect", async () => {
    const cursorStore = new MemoryCursorStore({
      uidValidity: "99",
      lastProcessedUid: "100",
    });
    const firstClient = new FakeIdleClient();
    firstClient.searchResults.push([]);
    const secondClient = new FakeIdleClient();
    secondClient.searchResults.push([101]);
    addMessage(secondClient, 101);
    const { options, tokenProvider, clientFactory } = createOptions(
      cursorStore,
      [firstClient, secondClient],
    );
    const listener = new GmailIdleListener(options);
    const handler = vi.fn(async (_candidate: CandidateEmail) => undefined);
    const running = listener.start(handler);

    await waitUntilIdling(listener);
    firstClient.emit("close");
    await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await listener.stop();
    await running;

    expect(handler.mock.calls[0]?.[0].uid).toBe("101");
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    expect(cursorStore.cursor?.lastProcessedUid).toBe("101");
  });

  it("uses the persisted cursor after restart and suppresses duplicates", async () => {
    const cursorStore = new MemoryCursorStore({
      uidValidity: "99",
      lastProcessedUid: "100",
    });
    const firstClient = new FakeIdleClient();
    firstClient.searchResults.push([101]);
    addMessage(firstClient, 101);
    const firstOptions = createOptions(cursorStore, [firstClient]).options;
    const firstListener = new GmailIdleListener(firstOptions);
    const firstHandler = vi.fn(
      async (_candidate: CandidateEmail) => undefined,
    );
    const firstRun = firstListener.start(firstHandler);
    await waitUntilIdling(firstListener);
    await firstListener.stop();
    await firstRun;

    const secondClient = new FakeIdleClient();
    secondClient.searchResults.push([101, 102]);
    addMessage(secondClient, 101);
    addMessage(secondClient, 102);
    const secondOptions = createOptions(cursorStore, [secondClient]).options;
    const secondListener = new GmailIdleListener(secondOptions);
    const secondHandler = vi.fn(
      async (_candidate: CandidateEmail) => undefined,
    );
    const secondRun = secondListener.start(secondHandler);
    await waitUntilIdling(secondListener);
    await secondListener.stop();
    await secondRun;

    expect(firstHandler.mock.calls[0]?.[0].uid).toBe("101");
    expect(secondHandler).toHaveBeenCalledOnce();
    expect(secondHandler.mock.calls[0]?.[0].uid).toBe("102");
  });
});
