/**
 * Reporter — collects subprocess results, runs git status,
 * maps exit codes to status, and composes callback envelopes.
 *
 * daemon-protocol.md §5 (exit-code mapping)
 */

import { execSync } from 'node:child_process';
import { parseAgentOutput } from './agent-output.js';
import type { CallbackPayload, CliBinary, TaskRunStatus } from './types.js';

const STDOUT_TAIL_LINES = 50;
const STDERR_TAIL_LINES = 30;
const FINAL_MESSAGE_MAX_CHARS = 4000;

/** Tail the last N lines of a string */
function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n').trim();
}

/**
 * Run git status --porcelain in cwd and return list of changed file paths.
 * Returns empty array if not a git repo or git not available.
 */
export function getChangedFiles(cwd: string): string[] {
  try {
    const out = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).trim()); // strip XY status prefix
  } catch {
    return [];
  }
}

/**
 * Map exit code + diff to TaskRunStatus per daemon-protocol.md §5:
 *   exit 0, non-empty diff → completed
 *   exit 0, empty diff    → completed (metadata.emptyDiff = true)
 *   exit non-zero         → failed
 */
export function mapExitCodeToStatus(exitCode: number): TaskRunStatus {
  return exitCode === 0 ? 'completed' : 'failed';
}

export interface ReporterInput {
  taskRunId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  cwd: string;
  /** Which CLI produced the output — selects the structured-output parser. */
  binary?: CliBinary;
  /** True when the daemon killed the subprocess on wall-clock timeout. */
  timedOut?: boolean;
}

/**
 * Build the callback envelope payload.
 *
 * `git status` remains the ground truth for changed files (it sees the real
 * worktree), with the agent's own file_change reports as fallback when the
 * cwd isn't a usable git repo. Structured stdout (stream-json / codex JSONL)
 * supplies session id, token usage, cost, and the final message as metadata.
 */
export function buildCallbackPayload(input: ReporterInput): CallbackPayload {
  const parsed = parseAgentOutput(input.binary ?? 'claude', input.stdout);
  const gitFiles = getChangedFiles(input.cwd);
  const changedFiles = gitFiles.length > 0 ? gitFiles : parsed.reportedFiles ?? [];
  const status = mapExitCodeToStatus(input.exitCode);
  const emptyDiff = input.exitCode === 0 && changedFiles.length === 0;

  const payload: CallbackPayload = {
    exitCode: input.exitCode,
    changedFiles,
    summary: input.timedOut
      ? 'timeout'
      : buildSummary(input.exitCode, changedFiles, input.stdout),
    durationMs: input.durationMs,
    stdoutTail: tailLines(input.stdout, STDOUT_TAIL_LINES),
    stderrTail: tailLines(input.stderr, STDERR_TAIL_LINES),
    status,
  };

  const metadata: NonNullable<CallbackPayload['metadata']> = {};
  if (emptyDiff) metadata.emptyDiff = true;
  if (input.timedOut) metadata.timedOut = true;
  if (parsed.agentSessionId) metadata.agentSessionId = parsed.agentSessionId;
  if (parsed.usage) metadata.usage = parsed.usage;
  if (parsed.costUsd !== undefined) metadata.costUsd = parsed.costUsd;
  if (parsed.finalMessage) {
    metadata.finalMessage = parsed.finalMessage.slice(0, FINAL_MESSAGE_MAX_CHARS);
  }
  if (Object.keys(metadata).length > 0) payload.metadata = metadata;

  return payload;
}

function buildSummary(
  exitCode: number,
  changedFiles: string[],
  stdout: string,
): string {
  if (exitCode === 124) return 'timeout';

  if (exitCode !== 0) {
    return `CLI exited with code ${exitCode}`;
  }

  if (changedFiles.length === 0) {
    return 'Completed with no file changes';
  }

  return `Modified ${changedFiles.length} file(s): ${changedFiles.slice(0, 5).join(', ')}${
    changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : ''
  }`;
}
