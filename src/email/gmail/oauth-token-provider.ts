import { OAuth2Client } from "google-auth-library";

import type { RefreshTokenStore } from "./token-store.js";

export interface OAuthTokenProvider {
  getAccessToken(): Promise<string>;
}

interface GoogleAccessTokenClient {
  setCredentials(credentials: { refresh_token: string }): void;
  getAccessToken(): Promise<{ token?: string | null }>;
}

export interface GoogleOAuthTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStore: RefreshTokenStore;
  client?: GoogleAccessTokenClient;
}

export class GoogleOAuthTokenProvider implements OAuthTokenProvider {
  private readonly client: GoogleAccessTokenClient;
  private accessTokenRequest: Promise<string> | undefined;

  constructor(private readonly options: GoogleOAuthTokenProviderOptions) {
    this.client =
      options.client ??
      new OAuth2Client({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        redirectUri: options.redirectUri,
      });
  }

  getAccessToken(): Promise<string> {
    if (!this.accessTokenRequest) {
      this.accessTokenRequest = this.requestAccessToken().finally(() => {
        this.accessTokenRequest = undefined;
      });
    }

    return this.accessTokenRequest;
  }

  private async requestAccessToken(): Promise<string> {
    try {
      const refreshToken = await this.options.tokenStore.load();
      this.client.setCredentials({ refresh_token: refreshToken });

      const response = await this.client.getAccessToken();
      if (!response.token) {
        throw new Error("Missing access token.");
      }

      return response.token;
    } catch {
      throw new Error(
        "Unable to obtain Gmail access. Run `npm run oauth:gmail` to authorize again.",
      );
    }
  }
}
