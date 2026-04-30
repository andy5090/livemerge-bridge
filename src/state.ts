/**
 * Persistent agent state manager.
 * Stores session token, rotation timestamps, and current task run ID.
 * State file: ~/.livemerge-bridge/state.json (or $LIVEMERGE_AGENT_DIR/state.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentState } from './types.js';

const MAX_SEEN_IDS = 500; // prevent unbounded growth

function getStateDir(): string {
  return process.env['LIVEMERGE_AGENT_DIR'] ?? path.join(os.homedir(), '.livemerge-bridge');
}

function getStatePath(): string {
  return path.join(getStateDir(), 'state.json');
}

function ensureStateDir(): void {
  const dir = getStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readState(): AgentState | null {
  const p = getStatePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as AgentState;
  } catch {
    return null;
  }
}

export function writeState(state: AgentState): void {
  ensureStateDir();
  // Trim seenTaskRunIds to avoid unbounded growth
  const trimmed: AgentState = {
    ...state,
    seenTaskRunIds: (state.seenTaskRunIds ?? []).slice(-MAX_SEEN_IDS),
  };
  fs.writeFileSync(getStatePath(), JSON.stringify(trimmed, null, 2), 'utf-8');
}

export function updateState(partial: Partial<AgentState>): AgentState {
  const current = readState() ?? {
    sessionToken: '',
    lastRotatedAt: new Date().toISOString(),
    currentTaskRunId: null,
    seenTaskRunIds: [],
  };
  const next: AgentState = { ...current, ...partial };
  writeState(next);
  return next;
}

export function clearCurrentTask(): void {
  const current = readState();
  if (current) {
    writeState({ ...current, currentTaskRunId: null });
  }
}

export function markTaskSeen(taskRunId: string): void {
  const current = readState();
  if (!current) return;
  const seen = current.seenTaskRunIds ?? [];
  if (!seen.includes(taskRunId)) {
    writeState({ ...current, seenTaskRunIds: [...seen, taskRunId] });
  }
}

export function hasSeenTask(taskRunId: string): boolean {
  const current = readState();
  return (current?.seenTaskRunIds ?? []).includes(taskRunId);
}
