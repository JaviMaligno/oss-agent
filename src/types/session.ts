export type SessionStatus = "active" | "paused" | "completed" | "failed" | "awaiting_feedback";

export interface Session {
  id: string;
  issueId: string;
  issueUrl: string;
  status: SessionStatus;
  provider: string;
  model: string;
  startedAt: Date;
  lastActivityAt: Date;
  completedAt: Date | null;
  turnCount: number;
  costUsd: number;
  prUrl: string | null;
  workingDirectory: string;
  canResume: boolean;
  error: string | null;
}

export interface SessionTransition {
  sessionId: string;
  fromStatus: SessionStatus;
  toStatus: SessionStatus;
  timestamp: Date;
  reason: string;
}
