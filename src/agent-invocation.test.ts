/**
 * Unit tests for the headless invocation surface added for Claude Code /
 * Codex CLI (2026): default permission/sandbox flags, structured output,
 * resume translation, timeout mapping, and JSONL output parsing.
 */

import { describe, it, expect } from 'vitest';
import { buildArgs, spawnCli } from './dispatcher.js';
import { parseAgentOutput } from './agent-output.js';
import { buildCallbackPayload } from './reporter.js';

describe('buildArgs — claude', () => {
  it('applies headless defaults: stream-json output + acceptEdits permissions, prompt last', () => {
    const args = buildArgs('claude', 'do the task', []);
    expect(args).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      'do the task',
    ]);
  });

  it('server-supplied --permission-mode overrides the default', () => {
    const args = buildArgs('claude', 't', ['--permission-mode', 'plan']);
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('translates --resume into a native claude --resume flag', () => {
    const args = buildArgs('claude', 't', ['--resume', 'sess-123']);
    const i = args.indexOf('--resume');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('sess-123');
    expect(args[args.length - 1]).toBe('t');
  });

  it('passes through extra flags like --model', () => {
    const args = buildArgs('claude', 't', ['--model', 'claude-sonnet-5']);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });
});

describe('buildArgs — codex', () => {
  it('applies headless defaults: --json + workspace-write sandbox + never approvals', () => {
    const args = buildArgs('codex', 'do the task', []);
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox', 'workspace-write',
      '--ask-for-approval', 'never',
      'do the task',
    ]);
  });

  it('translates --resume into the exec resume subcommand form', () => {
    const args = buildArgs('codex', 't', ['--resume', 'thread-9']);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(args).not.toContain('--resume');
    expect(args[args.length - 1]).toBe('t');
  });

  it('server-supplied --sandbox overrides the default', () => {
    const args = buildArgs('codex', 't', ['--sandbox', 'read-only']);
    expect(args.filter((a) => a === '--sandbox')).toHaveLength(1);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });
});

describe('parseAgentOutput — claude stream-json', () => {
  const stdout = [
    '{"type":"system","subtype":"init","session_id":"abc-123","tools":[]}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    'non-json noise line',
    '{"type":"result","subtype":"success","result":"All done.","session_id":"abc-123","total_cost_usd":0.042,"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":90},"num_turns":3}',
  ].join('\n');

  it('extracts session id, final message, cost, and usage', () => {
    const p = parseAgentOutput('claude', stdout);
    expect(p.agentSessionId).toBe('abc-123');
    expect(p.finalMessage).toBe('All done.');
    expect(p.costUsd).toBe(0.042);
    expect(p.usage).toEqual({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 90 });
  });
});

describe('parseAgentOutput — codex JSONL', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"th-42"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/a.ts"},{"path":"src/b.ts"}]}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Fixed the bug."}}',
    '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":150,"output_tokens":80}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20}}',
  ].join('\n');

  it('extracts thread id, last agent message, accumulated usage, and reported files', () => {
    const p = parseAgentOutput('codex', stdout);
    expect(p.agentSessionId).toBe('th-42');
    expect(p.finalMessage).toBe('Fixed the bug.');
    expect(p.usage).toEqual({ inputTokens: 300, outputTokens: 100, cachedInputTokens: 200 });
    expect(p.reportedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns empty result on garbage input without throwing', () => {
    expect(parseAgentOutput('codex', 'plain text output')).toEqual({});
  });
});

describe('reporter — structured metadata & timeout', () => {
  it('surfaces agentSessionId / usage / cost / finalMessage in callback metadata', () => {
    const payload = buildCallbackPayload({
      taskRunId: 't1',
      exitCode: 0,
      stdout:
        '{"type":"result","subtype":"success","result":"Done","session_id":"s-1","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5}}',
      stderr: '',
      durationMs: 10,
      cwd: '/nonexistent-not-a-repo',
      binary: 'claude',
    });
    expect(payload.metadata?.agentSessionId).toBe('s-1');
    expect(payload.metadata?.costUsd).toBe(0.01);
    expect(payload.metadata?.finalMessage).toBe('Done');
    expect(payload.metadata?.usage?.inputTokens).toBe(10);
  });

  it('maps a timed-out run to failed status with timeout summary and metadata flag', () => {
    const payload = buildCallbackPayload({
      taskRunId: 't2',
      exitCode: 124,
      stdout: '',
      stderr: '',
      durationMs: 1000,
      cwd: '/nonexistent-not-a-repo',
      binary: 'codex',
      timedOut: true,
    });
    expect(payload.status).toBe('failed');
    expect(payload.summary).toBe('timeout');
    expect(payload.metadata?.timedOut).toBe(true);
  });

  it('falls back to agent-reported files when git sees no changes', () => {
    const payload = buildCallbackPayload({
      taskRunId: 't3',
      exitCode: 0,
      stdout:
        '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"x.ts"}]}}',
      stderr: '',
      durationMs: 10,
      cwd: '/nonexistent-not-a-repo',
      binary: 'codex',
    });
    expect(payload.changedFiles).toEqual(['x.ts']);
    expect(payload.metadata?.emptyDiff).toBeUndefined();
  });
});

describe('spawnCli — timeout enforcement', () => {
  it('kills a hung subprocess and reports exit 124 + timedOut', async () => {
    // 'claude' resolves to the real CLI on dev machines; to test the kill path
    // deterministically we point PATH at a stub that sleeps forever.
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'lm-stub-'));
    const stub = join(dir, 'claude');
    writeFileSync(stub, '#!/bin/sh\nsleep 60\n');
    chmodSync(stub, 0o755);
    const oldPath = process.env['PATH'];
    process.env['PATH'] = `${dir}:${oldPath ?? ''}`;
    try {
      const result = await spawnCli('claude', 'task', [], dir, 500);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
    } finally {
      process.env['PATH'] = oldPath;
    }
  }, 15_000);
});
