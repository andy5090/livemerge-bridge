/**
 * Structured-output parsers for headless agent runs.
 *
 * claude --print --output-format stream-json  → JSONL of {type: system|assistant|result, ...}
 * codex exec --json                           → JSONL of {type: thread.started|turn.completed|item.*, ...}
 *
 * Both streams are best-effort parsed: unknown lines and unknown fields are
 * ignored so a CLI upgrade degrades to "less metadata", never a crash.
 */

import type { CliBinary } from './types.js';

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface ParsedAgentOutput {
  /** CLI-native session/thread id — enables --resume / exec resume follow-ups. */
  agentSessionId?: string;
  /** Final assistant message (full text; caller truncates for transport). */
  finalMessage?: string;
  usage?: AgentUsage;
  /** USD cost as reported by the CLI (claude only). */
  costUsd?: number;
  /** File paths the agent itself reported changing (codex file_change items). */
  reportedFiles?: string[];
}

function toNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // non-JSON noise interleaved in stdout — skip
    }
  }
  return out;
}

function parseClaude(stdout: string): ParsedAgentOutput {
  const result: ParsedAgentOutput = {};
  for (const ev of jsonLines(stdout)) {
    if (typeof ev['session_id'] === 'string') {
      result.agentSessionId = ev['session_id'];
    }
    if (ev['type'] === 'result') {
      if (typeof ev['result'] === 'string') result.finalMessage = ev['result'];
      const cost = toNum(ev['total_cost_usd']);
      if (cost !== undefined) result.costUsd = cost;
      const usage = ev['usage'];
      if (typeof usage === 'object' && usage !== null) {
        const u = usage as Record<string, unknown>;
        const parsedUsage: AgentUsage = {};
        const input = toNum(u['input_tokens']);
        const output = toNum(u['output_tokens']);
        const cached = toNum(u['cache_read_input_tokens']);
        if (input !== undefined) parsedUsage.inputTokens = input;
        if (output !== undefined) parsedUsage.outputTokens = output;
        if (cached !== undefined) parsedUsage.cachedInputTokens = cached;
        result.usage = parsedUsage;
      }
    }
  }
  return result;
}

function parseCodex(stdout: string): ParsedAgentOutput {
  const result: ParsedAgentOutput = {};
  const usage: AgentUsage = {};
  let sawUsage = false;
  const files = new Set<string>();

  for (const ev of jsonLines(stdout)) {
    const type = ev['type'];
    if (type === 'thread.started' && typeof ev['thread_id'] === 'string') {
      result.agentSessionId = ev['thread_id'];
    }
    if (type === 'turn.completed') {
      const u = ev['usage'];
      if (typeof u === 'object' && u !== null) {
        const uu = u as Record<string, unknown>;
        sawUsage = true;
        usage.inputTokens = (usage.inputTokens ?? 0) + (toNum(uu['input_tokens']) ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (toNum(uu['output_tokens']) ?? 0);
        usage.cachedInputTokens =
          (usage.cachedInputTokens ?? 0) + (toNum(uu['cached_input_tokens']) ?? 0);
      }
    }
    if (type === 'item.completed') {
      const item = ev['item'];
      if (typeof item !== 'object' || item === null) continue;
      const it = item as Record<string, unknown>;
      const itemType = it['type'] ?? it['item_type'];
      if (itemType === 'agent_message' && typeof it['text'] === 'string') {
        result.finalMessage = it['text']; // last agent_message wins
      }
      if (itemType === 'file_change') {
        // Sub-field shape varies across CLI versions — accept both known forms.
        if (typeof it['path'] === 'string') files.add(it['path']);
        const changes = it['changes'];
        if (Array.isArray(changes)) {
          for (const c of changes) {
            if (typeof c === 'object' && c !== null) {
              const p = (c as Record<string, unknown>)['path'];
              if (typeof p === 'string') files.add(p);
            }
          }
        }
      }
    }
  }

  if (sawUsage) result.usage = usage;
  if (files.size > 0) result.reportedFiles = [...files];
  return result;
}

export function parseAgentOutput(binary: CliBinary, stdout: string): ParsedAgentOutput {
  return binary === 'codex' ? parseCodex(stdout) : parseClaude(stdout);
}

// ─── Live (incremental) parsing — feeds the daemon TUI ───────────────────────

export type LiveAgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'tool_use'; name: string; detail?: string }
  | { kind: 'file_change'; paths: string[] }
  | { kind: 'message'; text: string }
  | { kind: 'turn_completed'; usage?: AgentUsage }
  | { kind: 'result'; costUsd?: number };

function clip(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function claudeLineToEvents(ev: Record<string, unknown>): LiveAgentEvent[] {
  const out: LiveAgentEvent[] = [];
  if (ev['type'] === 'system' && ev['subtype'] === 'init' && typeof ev['session_id'] === 'string') {
    out.push({ kind: 'session', sessionId: ev['session_id'] });
  }
  if (ev['type'] === 'assistant') {
    const msg = ev['message'];
    const content =
      typeof msg === 'object' && msg !== null
        ? (msg as Record<string, unknown>)['content']
        : undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
          const input = (b['input'] ?? {}) as Record<string, unknown>;
          const detail = input['file_path'] ?? input['command'] ?? input['pattern'];
          out.push({
            kind: 'tool_use',
            name: b['name'],
            ...(typeof detail === 'string' ? { detail: clip(detail) } : {}),
          });
        }
        if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) {
          out.push({ kind: 'message', text: clip(b['text'].trim(), 200) });
        }
      }
    }
  }
  if (ev['type'] === 'result') {
    const costUsd = toNum(ev['total_cost_usd']);
    out.push({ kind: 'result', ...(costUsd !== undefined ? { costUsd } : {}) });
  }
  return out;
}

function codexLineToEvents(ev: Record<string, unknown>): LiveAgentEvent[] {
  const out: LiveAgentEvent[] = [];
  const type = ev['type'];
  if (type === 'thread.started' && typeof ev['thread_id'] === 'string') {
    out.push({ kind: 'session', sessionId: ev['thread_id'] });
  }
  if (type === 'turn.completed') {
    const u = ev['usage'];
    if (typeof u === 'object' && u !== null) {
      const uu = u as Record<string, unknown>;
      const usage: AgentUsage = {};
      const input = toNum(uu['input_tokens']);
      const output = toNum(uu['output_tokens']);
      if (input !== undefined) usage.inputTokens = input;
      if (output !== undefined) usage.outputTokens = output;
      out.push({ kind: 'turn_completed', usage });
    } else {
      out.push({ kind: 'turn_completed' });
    }
  }
  if (type === 'item.started' || type === 'item.completed') {
    const item = ev['item'];
    if (typeof item !== 'object' || item === null) return out;
    const it = item as Record<string, unknown>;
    const itemType = it['type'] ?? it['item_type'];
    if (type === 'item.started' && itemType === 'command_execution') {
      const cmd = it['command'];
      out.push({
        kind: 'tool_use',
        name: 'shell',
        ...(typeof cmd === 'string' ? { detail: clip(cmd) } : {}),
      });
    }
    if (type === 'item.completed' && itemType === 'agent_message' && typeof it['text'] === 'string') {
      out.push({ kind: 'message', text: clip(it['text'].trim(), 200) });
    }
    if (type === 'item.completed' && itemType === 'file_change') {
      const paths: string[] = [];
      if (typeof it['path'] === 'string') paths.push(it['path']);
      const changes = it['changes'];
      if (Array.isArray(changes)) {
        for (const c of changes) {
          if (typeof c === 'object' && c !== null) {
            const p = (c as Record<string, unknown>)['path'];
            if (typeof p === 'string') paths.push(p);
          }
        }
      }
      if (paths.length > 0) out.push({ kind: 'file_change', paths });
    }
  }
  return out;
}

export interface LiveParser {
  /** Feed a stdout chunk; complete lines are parsed and emitted immediately. */
  push(chunk: string): void;
  /** Parse any trailing partial line (call once at process exit). */
  flush(): void;
}

/**
 * Incremental JSONL parser. Buffers partial lines across chunks and emits
 * normalized LiveAgentEvents as complete lines arrive. Best-effort like
 * parseAgentOutput — unknown lines are silently skipped.
 */
export function createLiveParser(
  binary: CliBinary,
  onEvent: (event: LiveAgentEvent) => void,
): LiveParser {
  const toEvents = binary === 'codex' ? codexLineToEvents : claudeLineToEvents;
  let buffer = '';

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const ev of toEvents(parsed as Record<string, unknown>)) onEvent(ev);
      }
    } catch {
      // partial or non-JSON line — skip
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    },
    flush() {
      if (buffer) parseLine(buffer);
      buffer = '';
    },
  };
}
