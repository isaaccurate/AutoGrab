export type ListenerState =
  | "stopped"
  | "authenticating"
  | "connecting"
  | "reconciling"
  | "idling"
  | "backing-off";

export interface ListenerStatus {
  readonly state: ListenerState;
  readonly changedAt: Date;
  readonly reconnectAttempt: number;
  readonly lastEventAt: Date | null;
  readonly lastError: string | null;
}

export function reconnectDelayMs(attempt: number): number {
  const schedule = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
  return schedule[Math.min(attempt, schedule.length - 1)] ?? 30_000;
}
