import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

import { GMAIL_IMAP } from "./constants.js";
import type { RefreshTokenStore } from "./token-store.js";

const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface GmailAuthorizationOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStore: RefreshTokenStore;
  openAuthorizationUrl: (url: string) => Promise<void>;
  timeoutMs?: number;
}

interface AuthorizationCallback {
  code: string;
  close: () => Promise<void>;
}

export function validateLoopbackRedirectUri(value: string): URL {
  const redirectUri = new URL(value);

  if (
    redirectUri.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(redirectUri.hostname) ||
    redirectUri.username ||
    redirectUri.password ||
    redirectUri.search ||
    redirectUri.hash ||
    !redirectUri.port
  ) {
    throw new Error(
      "Gmail OAuth redirect URI must be an HTTP loopback URL with an explicit port.",
    );
  }

  return redirectUri;
}

function statesMatch(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForAuthorizationCallback(
  redirectUri: URL,
  expectedState: string,
  timeoutMs: number,
  openAuthorizationUrl: () => Promise<void>,
): Promise<AuthorizationCallback> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", redirectUri);

      if (requestUrl.pathname !== redirectUri.pathname) {
        response.writeHead(404).end("Not found.");
        return;
      }

      if (settled) {
        response.writeHead(409).end("Authorization callback already received.");
        return;
      }

      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const oauthError = requestUrl.searchParams.get("error");

      if (oauthError) {
        settled = true;
        response.writeHead(400).end("Google authorization was not approved.");
        clearTimeout(timeout);
        void closeServer(server).finally(() => {
          reject(new Error("Google authorization was not approved."));
        });
        return;
      }

      if (!state || !statesMatch(expectedState, state) || !code) {
        response.writeHead(400).end("Invalid authorization callback.");
        return;
      }

      settled = true;
      response
        .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Authorization received. You may close this browser tab.");
      clearTimeout(timeout);
      resolve({
        code,
        close: () => closeServer(server),
      });
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void closeServer(server).finally(() => {
        reject(new Error("Gmail authorization timed out."));
      });
    }, timeoutMs);

    server.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Unable to start the OAuth callback server: ${error.message}`));
    });

    const listenHost =
      redirectUri.hostname === "[::1]" ? "::1" : redirectUri.hostname;

    server.listen(Number(redirectUri.port), listenHost, () => {
      void openAuthorizationUrl().catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void closeServer(server).finally(() => {
          reject(new Error("Unable to open the Google authorization page."));
        });
      });
    });
  });
}

export async function authorizeGmail(
  options: GmailAuthorizationOptions,
): Promise<void> {
  const parsedRedirectUri = validateLoopbackRedirectUri(options.redirectUri);
  const redirectUri = parsedRedirectUri.toString();
  const oauthClient = new OAuth2Client({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri,
  });
  const state = randomBytes(32).toString("base64url");
  const { codeVerifier, codeChallenge } =
    await oauthClient.generateCodeVerifierAsync();

  if (!codeChallenge) {
    throw new Error("Unable to create a secure OAuth code challenge.");
  }

  const authorizationUrl = oauthClient.generateAuthUrl({
    access_type: GMAIL_IMAP.oauthAccessType,
    prompt: "consent",
    scope: [...GMAIL_IMAP.oauthScopes],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  const callbackPromise = waitForAuthorizationCallback(
    parsedRedirectUri,
    state,
    options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS,
    () => options.openAuthorizationUrl(authorizationUrl),
  );
  const callback = await callbackPromise;

  try {
    const { tokens } = await oauthClient.getToken({
      code: callback.code,
      codeVerifier,
      redirect_uri: redirectUri,
    });

    if (!tokens.refresh_token) {
      throw new Error(
        "Google did not return a refresh credential. Revoke AutoGrab access and authorize again.",
      );
    }

    await options.tokenStore.save(tokens.refresh_token);
  } finally {
    await callback.close();
  }
}
