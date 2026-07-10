/**
 * In-process event bus feeding the daemon TUI.
 *
 * The transport clients emit task lifecycle + live agent events here; the Ink
 * app subscribes. When no TUI is attached the emitter simply has no listeners
 * — plain console logging (patched into Ink's <Static> when the TUI is up)
 * remains the source of the scrollback feed either way.
 */

import { EventEmitter } from 'node:events';
import type { LiveAgentEvent } from './agent-output.js';
import type { CliBinary } from './types.js';

export interface TaskStartedEvent {
  taskRunId: string;
  binary: CliBinary;
  cwd: string;
  /** Present for worktree (non-primary) tasks. */
  branch?: string;
  prompt: string;
}

export interface TaskCompletedEvent {
  taskRunId: string;
  status: 'completed' | 'failed';
  durationMs: number;
  changedFiles: number;
  costUsd?: number;
  branch?: string;
}

export interface ConnectionEvent {
  status: 'connected' | 'polling' | 'error' | 'revoked';
  detail?: string;
}

export interface BridgeUiEvents {
  connection: (e: ConnectionEvent) => void;
  taskStarted: (e: TaskStartedEvent) => void;
  taskActivity: (taskRunId: string, event: LiveAgentEvent) => void;
  taskCompleted: (e: TaskCompletedEvent) => void;
}

class UiEmitter extends EventEmitter {
  override emit<K extends keyof BridgeUiEvents>(
    event: K,
    ...args: Parameters<BridgeUiEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof BridgeUiEvents>(event: K, listener: BridgeUiEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof BridgeUiEvents>(event: K, listener: BridgeUiEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

/** Singleton bus — one daemon process, one UI. */
export const uiEvents = new UiEmitter();
uiEvents.setMaxListeners(50);
