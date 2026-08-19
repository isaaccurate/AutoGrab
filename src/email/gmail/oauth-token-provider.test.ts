import { describe, expect, it, vi } from "vitest";

import { GoogleOAuthTokenProvider } from "./oauth-token-provider.js";

function createOptions(overrides?: {
  load?: () => Promise<string>;
  getAccessToken?: () => Promise<{ token?: string | null }>;
}) {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3000/",
    tokenStore: {
      load: vi.fn(overrides?.load ?? (async () => "refresh-token")),
      save: vi.fn(),
    },
    client: {
      setCredentials: vi.fn(),
      getAccessToken: vi.fn(
        overrides?.getAccessToken ?? (async () => ({ token: "access-token" })),
      ),
    },
  };
}

describe("GoogleOAuthTokenProvider", () => {
  it("uses the stored refresh credential to obtain an access token", async () => {
    const options = createOptions();
    const provider = new GoogleOAuthTokenProvider(options);

    await expect(provider.getAccessToken()).resolves.toBe("access-token");
    expect(options.client.setCredentials).toHaveBeenCalledWith({
      refresh_token: "refresh-token",
    });
  });

  it("deduplicates simultaneous access-token requests", async () => {
    const options = createOptions();
    const provider = new GoogleOAuthTokenProvider(options);

    await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);

    expect(options.tokenStore.load).toHaveBeenCalledTimes(1);
    expect(options.client.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("returns a sanitized error when token refresh fails", async () => {
    const options = createOptions({
      getAccessToken: async () => {
        throw new Error("response contained secret-token-value");
      },
    });
    const provider = new GoogleOAuthTokenProvider(options);

    await expect(provider.getAccessToken()).rejects.toThrow(
      "Unable to obtain Gmail access.",
    );
    await expect(provider.getAccessToken()).rejects.not.toThrow(
      "secret-token-value",
    );
  });
});
