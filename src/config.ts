import { z } from "zod";

import { GMAIL_IMAP } from "./email/gmail/constants.js";

const envSchema = z.object({
  AUTOGRAB_EMAIL_ADDRESS: z.string().email(),
  AUTOGRAB_GOOGLE_CLIENT_ID: z.string().min(1),
  AUTOGRAB_GOOGLE_CLIENT_SECRET: z.string().min(1),
  AUTOGRAB_GOOGLE_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:3000"),
  AUTOGRAB_IMAP_HOST: z.string().min(1).default(GMAIL_IMAP.host),
  AUTOGRAB_IMAP_PORT: z.coerce.number().int().positive().default(GMAIL_IMAP.port),
  AUTOGRAB_ALLOWED_SENDERS: z.string().min(1).refine(
    (value) =>
      splitCsv(value).every((sender) => z.string().email().safeParse(sender).success),
    "Every allowed sender must be a valid email address.",
  ),
  AUTOGRAB_TARGET_SLNS: z.string().min(1).refine(
    (value) => splitCsv(value).every((sln) => /^\d{5}$/.test(sln)),
    "Every target SLN must contain exactly five digits.",
  ),
  AUTOGRAB_TARGET_QUARTER: z
    .string()
    .regex(/^(?:wi|sp|su|au)\d{2}$/, "The target quarter must look like au26."),
  AUTOGRAB_NOTIFICATION_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3_600)
    .default(600),
  AUTOGRAB_REGISTRATION_MODE: z.enum(["dry-run", "live"]).default("dry-run"),
});

export interface AppConfig {
  emailAddress: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  imapHost: string;
  imapPort: number;
  allowedSenders: readonly string[];
  targetSlns: readonly string[];
  targetQuarter: string;
  notificationMaxAgeMs: number;
  registrationMode: "dry-run" | "live";
}

function splitCsv(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    emailAddress: parsed.AUTOGRAB_EMAIL_ADDRESS.toLowerCase(),
    googleClientId: parsed.AUTOGRAB_GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.AUTOGRAB_GOOGLE_CLIENT_SECRET,
    googleRedirectUri: parsed.AUTOGRAB_GOOGLE_REDIRECT_URI,
    imapHost: parsed.AUTOGRAB_IMAP_HOST,
    imapPort: parsed.AUTOGRAB_IMAP_PORT,
    allowedSenders: splitCsv(parsed.AUTOGRAB_ALLOWED_SENDERS).map((sender) =>
      sender.toLowerCase(),
    ),
    targetSlns: splitCsv(parsed.AUTOGRAB_TARGET_SLNS),
    targetQuarter: parsed.AUTOGRAB_TARGET_QUARTER,
    notificationMaxAgeMs:
      parsed.AUTOGRAB_NOTIFICATION_MAX_AGE_SECONDS * 1_000,
    registrationMode: parsed.AUTOGRAB_REGISTRATION_MODE,
  };
}
