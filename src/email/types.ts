export interface MailboxCursor {
  readonly uidValidity: string;
  readonly lastProcessedUid: string;
}

export interface CandidateEmail {
  readonly uidValidity: string;
  readonly uid: string;
  readonly messageId: string | null;
  readonly from: readonly string[];
  readonly subject: string | null;
  readonly receivedAt: Date;
  readonly size: number | null;
  readonly rawSource: Buffer | null;
}

export type CandidateEmailHandler = (message: CandidateEmail) => Promise<void>;

export interface EmailListener {
  start(onCandidate: CandidateEmailHandler): Promise<void>;
  stop(): Promise<void>;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface MailboxCursorStore {
  load(): Promise<MailboxCursor | null>;
  save(cursor: MailboxCursor): Promise<void>;
}
