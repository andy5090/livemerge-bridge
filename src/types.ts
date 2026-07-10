/**
 * TypeScript types for all envelope shapes per daemon-protocol.md §1.3
 */

export type MessageType =
  | 'hello'
  | 'hello-ack'
  | 'heartbeat'
  | 'heartbeat-ack'
  | 'dispatch'
  | 'dispatch-ack'
  | 'dispatch-reject'
  | 'callback'
  | 'callback-ack'
  | 'card-refresh'
  | 'error'
  | 'bye';

export type CliBinary = 'claude' | 'codex';

/** Base envelope shape — every WS message conforms to this */
export interface Envelope<T extends MessageType, P> {
  v: number;
  type: T;
  taskRunId: string | null;
  payload: P;
  ts: string; // ISO-8601
}

// ─── Payload shapes ───────────────────────────────────────────────────────────

export interface HelloPayload {
  agentVersion: string;
  os: string;
  node: string;
  supportedVersions: number[];
  /** If restarting mid-task, include last active taskRunId */
  lastTaskRunId?: string | null;
}

export interface DispatchPolicy {
  maxConcurrent: number;
  queueDepth: number;
}

export interface HelloAckPayload {
  chosenVersion: number;
  serverTime: string; // ISO-8601
  dispatchPolicy: DispatchPolicy;
  /** Present only when server rotates session token (§2.2) */
  rotatedSessionToken?: string;
}

export interface HeartbeatPayload {
  lastTaskRunId: string | null;
  idleSince: string | null; // ISO-8601 or null if busy
}

export interface HeartbeatAckPayload {
  // empty per protocol
}

export interface DispatchPayload {
  taskDescription: string;
  cwd: string;
  cliBinary: CliBinary;
  cliArgs: string[];
  /** Base64-encoded Ed25519 signature over canonical JSON of the dispatch content */
  signature: string;
  /** Signing key id (§3.4 rotation). Absent only on legacy envelopes. */
  kid?: string;
}

export interface DispatchAckPayload {
  ackedAt: string; // ISO-8601
  willStartAt: string; // ISO-8601
}

export type DispatchRejectReason =
  | 'busy'
  | 'unknown-binary'
  | 'signature-invalid'
  | 'cwd-missing';

export interface DispatchRejectPayload {
  reason: DispatchRejectReason;
  /** Present when reason='busy' */
  currentTaskRunId?: string;
}

export interface CallbackPayload {
  exitCode: number;
  changedFiles: string[];
  summary: string;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  status: TaskRunStatus;
  metadata?: {
    emptyDiff?: boolean;
    /** Daemon killed the subprocess on wall-clock timeout. */
    timedOut?: boolean;
    /** CLI-native session/thread id — server stores it for --resume follow-ups. */
    agentSessionId?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    };
    costUsd?: number;
    /** Final assistant message (truncated). */
    finalMessage?: string;
    [key: string]: unknown;
  };
}

export interface CallbackAckPayload {
  // empty per protocol
}

export interface ErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ByePayload {
  reason: string;
}

// ─── Named envelope aliases ───────────────────────────────────────────────────

export type HelloEnvelope = Envelope<'hello', HelloPayload>;
export type HelloAckEnvelope = Envelope<'hello-ack', HelloAckPayload>;
export type HeartbeatEnvelope = Envelope<'heartbeat', HeartbeatPayload>;
export type HeartbeatAckEnvelope = Envelope<'heartbeat-ack', HeartbeatAckPayload>;
export type DispatchEnvelope = Envelope<'dispatch', DispatchPayload>;
export type DispatchAckEnvelope = Envelope<'dispatch-ack', DispatchAckPayload>;
export type DispatchRejectEnvelope = Envelope<'dispatch-reject', DispatchRejectPayload>;
export type CallbackEnvelope = Envelope<'callback', CallbackPayload>;
export type CallbackAckEnvelope = Envelope<'callback-ack', CallbackAckPayload>;
export type ErrorEnvelope = Envelope<'error', ErrorPayload>;
export type ByeEnvelope = Envelope<'bye', ByePayload>;
/** Server → daemon: re-generate and re-upload the project context card. */
export type CardRefreshEnvelope = Envelope<'card-refresh', Record<string, never>>;

export type AnyEnvelope =
  | HelloEnvelope
  | HelloAckEnvelope
  | HeartbeatEnvelope
  | HeartbeatAckEnvelope
  | DispatchEnvelope
  | DispatchAckEnvelope
  | DispatchRejectEnvelope
  | CallbackEnvelope
  | CallbackAckEnvelope
  | ErrorEnvelope
  | ByeEnvelope
  | CardRefreshEnvelope;

// ─── Task run status (maps to server-side taskRuns.status) ───────────────────

export type TaskRunStatus = 'completed' | 'failed';

// ─── State shape ─────────────────────────────────────────────────────────────

export interface AgentState {
  sessionToken: string;
  lastRotatedAt: string; // ISO-8601
  currentTaskRunId: string | null;
  seenTaskRunIds: string[];
}
