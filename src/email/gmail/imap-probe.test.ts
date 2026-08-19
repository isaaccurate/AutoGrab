import { describe, expect, it, vi } from "vitest";

import { probeGmailImap } from "./imap-probe.js";

function createClient(overrides?: {
  capabilities?: Map<string, boolean | number>;
  secureConnection?: boolean;
  authenticated?: string | boolean;
  mailbox?: { path: string; readOnly?: boolean } | false;
  connect?: () => Promise<void>;
  logout?: () => Promise<void>;
}) {
  const lock = { release: vi.fn() };
  const client = {
    capabilities: overrides?.capabilities ?? new Map([["IDLE", true]]),
    secureConnection: overrides?.secureConnection ?? true,
    authenticated: overrides?.authenticated ?? "student@gmail.com",
    mailbox: overrides?.mailbox ?? { path: "INBOX", readOnly: true },
    connect: vi.fn(overrides?.connect ?? (async () => undefined)),
    getMailboxLock: vi.fn(async () => lock),
    logout: vi.fn(overrides?.logout ?? (async () => undefined)),
    close: vi.fn(),
    on: vi.fn(),
  };

  return { client, lock };
}

function createOptions(client: ReturnType<typeof createClient>["client"]) {
  return {
    host: "imap.gmail.com",
    port: 993,
    emailAddress: "student@gmail.com",
    mailbox: "INBOX",
    tokenProvider: {
      getAccessToken: vi.fn(async () => "test-access-token"),
    },
    clientFactory: vi.fn(() => client),
  };
}

describe("probeGmailImap", () => {
  it("verifies IDLE, selects INBOX read-only, and logs out", async () => {
    const { client, lock } = createClient();
    const options = createOptions(client);

    await expect(probeGmailImap(options)).resolves.toEqual({
      tlsEstablished: true,
      authenticated: true,
      idleSupported: true,
      mailboxSelected: "INBOX",
      mailboxReadOnly: true,
      disconnectedCleanly: true,
    });

    expect(options.clientFactory).toHaveBeenCalledWith("test-access-token");
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX", {
      readOnly: true,
      acquireTimeout: 10_000,
    });
    expect(lock.release).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledOnce();
    expect(client.close).not.toHaveBeenCalled();
  });

  it("rejects a server without IDLE and still logs out", async () => {
    const { client } = createClient({ capabilities: new Map() });

    await expect(probeGmailImap(createOptions(client))).rejects.toThrow(
      "did not advertise IMAP IDLE",
    );
    expect(client.getMailboxLock).not.toHaveBeenCalled();
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it("closes the socket after a failed connection", async () => {
    const { client } = createClient({
      connect: async () => {
        throw new Error("response with sensitive server details");
      },
    });

    await expect(probeGmailImap(createOptions(client))).rejects.toThrow(
      "Unable to establish the Gmail IMAP TLS/XOAUTH2 connection.",
    );
    await expect(probeGmailImap(createOptions(client))).rejects.not.toThrow(
      "sensitive server details",
    );
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("requires the selected mailbox to be read-only", async () => {
    const { client, lock } = createClient({
      mailbox: { path: "INBOX", readOnly: false },
    });

    await expect(probeGmailImap(createOptions(client))).rejects.toThrow(
      "did not confirm that the mailbox is read-only",
    );
    expect(lock.release).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it("reports an unclean disconnect and force-closes the socket", async () => {
    const { client } = createClient({
      logout: async () => {
        throw new Error("logout transport details");
      },
    });

    await expect(probeGmailImap(createOptions(client))).rejects.toThrow(
      "could not disconnect cleanly",
    );
    expect(client.close).toHaveBeenCalledOnce();
  });
});
