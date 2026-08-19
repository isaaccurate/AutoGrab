export const GMAIL_IMAP = {
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  mailbox: "INBOX",
  idleRefreshMs: 25 * 60 * 1_000,
  oauthScopes: ["https://mail.google.com/"],
  oauthAccessType: "offline",
} as const;

export const NOTIFY_UW = {
  sender: "notify-noreply@uw.edu",
  registrationOrigin: "https://register.uw.edu",
  maxMessageBytes: 256 * 1_024,
} as const;
