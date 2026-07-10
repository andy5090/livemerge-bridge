/**
 * Ink TUI for the bridge daemon.
 *
 * Layout:
 *   scrollback  — existing console.log/warn lines (Ink patches console, so
 *                 dispatch banners and completion lines land above the UI)
 *   header      — connection status, server, capacity
 *   task panel  — one live row per running task: spinner, agent, elapsed,
 *                 branch (worktree tasks), latest agent activity
 *
 * Started only when stdout is a TTY and --no-tui wasn't passed; headless runs
 * (CI, nohup, logs piped to a file) keep plain console output.
 */

import React, { useEffect, useState } from 'react';
import { render, Box, Text } from 'ink';
import { uiEvents, type TaskStartedEvent, type ConnectionEvent } from './ui-events.js';
import type { LiveAgentEvent } from './agent-output.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface TaskView {
  taskRunId: string;
  binary: string;
  branch?: string;
  prompt: string;
  startedAt: number;
  activity: string;
  turns: number;
  costUsd?: number;
}

export interface TuiMeta {
  version: string;
  serverUrl: string;
  projectDir: string;
  maxConcurrent: number;
}

function activityLabel(event: LiveAgentEvent): string | null {
  switch (event.kind) {
    case 'session':
      return `session ${event.sessionId.slice(0, 8)}`;
    case 'tool_use':
      return `⚒ ${event.name}${event.detail ? `  ${event.detail}` : ''}`;
    case 'file_change':
      return `✎ ${event.paths.slice(0, 3).join(', ')}${event.paths.length > 3 ? ` +${event.paths.length - 3}` : ''}`;
    case 'message':
      return `💬 ${event.text}`;
    case 'turn_completed':
    case 'result':
      return null; // handled as counters, keep last activity visible
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function TaskRow({ task, frame }: { task: TaskView; frame: number }) {
  const agentColor = task.binary === 'codex' ? 'magenta' : 'blue';
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box gap={1}>
        <Text color="cyan">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
        <Text color={agentColor} bold>
          {task.binary.toUpperCase()}
        </Text>
        <Text dimColor>{task.taskRunId.slice(0, 8)}</Text>
        <Text color="yellow">{fmtElapsed(Date.now() - task.startedAt)}</Text>
        {task.turns > 0 && <Text dimColor>turn {task.turns}</Text>}
        {task.costUsd !== undefined && <Text color="green">${task.costUsd.toFixed(3)}</Text>}
        {task.branch && <Text color="magenta">⎇ {task.branch}</Text>}
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate-end">
          “{task.prompt.slice(0, 70)}
          {task.prompt.length > 70 ? '…' : ''}”
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="white" wrap="truncate-end">
          {task.activity}
        </Text>
      </Box>
    </Box>
  );
}

function BridgeApp({ meta }: { meta: TuiMeta }) {
  const [tasks, setTasks] = useState<Map<string, TaskView>>(new Map());
  const [connection, setConnection] = useState<ConnectionEvent>({ status: 'polling' });
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onStarted = (e: TaskStartedEvent) => {
      setTasks((prev) => {
        const next = new Map(prev);
        next.set(e.taskRunId, {
          taskRunId: e.taskRunId,
          binary: e.binary,
          ...(e.branch ? { branch: e.branch } : {}),
          prompt: e.prompt,
          startedAt: Date.now(),
          activity: 'starting…',
          turns: 0,
        });
        return next;
      });
    };
    const onActivity = (taskRunId: string, event: LiveAgentEvent) => {
      setTasks((prev) => {
        const task = prev.get(taskRunId);
        if (!task) return prev;
        const next = new Map(prev);
        const updated: TaskView = { ...task };
        const label = activityLabel(event);
        if (label) updated.activity = label;
        if (event.kind === 'turn_completed') updated.turns += 1;
        if (event.kind === 'result' && event.costUsd !== undefined) {
          updated.costUsd = event.costUsd;
        }
        next.set(taskRunId, updated);
        return next;
      });
    };
    const onCompleted = (e: { taskRunId: string }) => {
      setTasks((prev) => {
        const next = new Map(prev);
        next.delete(e.taskRunId);
        return next;
      });
    };
    uiEvents.on('taskStarted', onStarted);
    uiEvents.on('taskActivity', onActivity);
    uiEvents.on('taskCompleted', onCompleted);
    uiEvents.on('connection', setConnection);
    return () => {
      uiEvents.off('taskStarted', onStarted);
      uiEvents.off('taskActivity', onActivity);
      uiEvents.off('taskCompleted', onCompleted);
      uiEvents.off('connection', setConnection);
    };
  }, []);

  const statusColor =
    connection.status === 'connected' || connection.status === 'polling'
      ? 'green'
      : connection.status === 'error'
        ? 'yellow'
        : 'red';
  const taskList = [...tasks.values()];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={statusColor}>●</Text>
        <Text bold color="cyan">
          LiveMerge Bridge
        </Text>
        <Text dimColor>v{meta.version}</Text>
        <Text dimColor>·</Text>
        <Text dimColor>{meta.serverUrl.replace(/^https?:\/\//, '')}</Text>
        <Text dimColor>·</Text>
        <Text>
          {taskList.length}/{meta.maxConcurrent} tasks
        </Text>
        {connection.detail && <Text color={statusColor}>{connection.detail}</Text>}
      </Box>
      {taskList.length === 0 ? (
        <Box paddingLeft={1}>
          <Text dimColor>idle — waiting for dispatches ({meta.projectDir})</Text>
        </Box>
      ) : (
        taskList.map((task) => <TaskRow key={task.taskRunId} task={task} frame={frame} />)
      )}
    </Box>
  );
}

export function startTui(meta: TuiMeta): { stop: () => void } {
  const instance = render(<BridgeApp meta={meta} />, { exitOnCtrlC: false });
  return {
    stop: () => {
      instance.unmount();
    },
  };
}
