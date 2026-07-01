/**
 * 任务链 chain 状态管理。
 *
 * 一条 chain = 多个 `@target prompt` 步骤的串行执行。
 * 步骤 N 完成 (isFinal) 后，watcher 触发 chainManager.advance(chainId) → 进入 N+1。
 * 失败默认终止链，剩余步骤标 'skipped'。
 *
 * 与 pending 的关系：
 *   每一步运行中的 pending 携带 chainId + chainStepIndex，
 *   notifier/watcher 通过这俩字段把 pending 完结事件映射回 chain。
 */

import { EventEmitter } from 'node:events';
import { logger } from 'multiagent-orchestrator';

export interface ChainStepRecord {
  /** @target 字符串（解析前的） */
  target: string;
  /** 该步骤的 prompt */
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  /** dispatch 后真实落到的 tty */
  tty?: string;
  startedAt?: number;
  endedAt?: number;
  /** 该步骤完成时的 output tail（短，用于 chain 卡片预览） */
  outputTailShort?: string;
  /** 失败原因（如：target 解析失败 / step 内部失败） */
  failureReason?: string;
}

export interface ChainState {
  id: string;
  chatId: string;
  createdAt: number;
  steps: ChainStepRecord[];
  /** 0-based，当前进行中或下一步执行的索引 */
  currentIndex: number;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** chain 进度卡的 message_id（创建时填，patch 用） */
  messageId?: string;
  /** 链整体结束时间 */
  endedAt?: number;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

function nextId(): string {
  return `ch-${Date.now().toString(36)}-${shortId()}`;
}

class ChainManager {
  readonly events = new EventEmitter();
  private states = new Map<string, ChainState>();
  /** 已结束的 chain 保留 N 条供 /chain status 查看 */
  private done: ChainState[] = [];
  private static DONE_LIMIT = 20;

  create(input: {
    chatId: string;
    steps: { target: string; prompt: string }[];
  }): ChainState {
    const id = nextId();
    const state: ChainState = {
      id,
      chatId: input.chatId,
      createdAt: Date.now(),
      steps: input.steps.map((s) => ({
        target: s.target,
        prompt: s.prompt,
        status: 'pending',
      })),
      currentIndex: 0,
      status: 'running',
    };
    this.states.set(id, state);
    logger.info('chain created', {
      id,
      chatId: input.chatId,
      steps: state.steps.length,
    });
    return state;
  }

  get(id: string): ChainState | undefined {
    return this.states.get(id) ?? this.done.find((c) => c.id === id);
  }

  setMessageId(id: string, messageId: string): void {
    const c = this.states.get(id);
    if (!c) return;
    c.messageId = messageId;
  }

  /** 标记第 index 步开始（dispatch 之后），关联实际 tty */
  markStepRunning(id: string, index: number, tty: string): void {
    const c = this.states.get(id);
    if (!c) return;
    const step = c.steps[index];
    if (!step) return;
    step.status = 'running';
    step.tty = tty;
    step.startedAt = Date.now();
    c.currentIndex = index;
    this.events.emit('updated', c);
  }

  /**
   * 标记第 index 步完成 → 返回 next step descriptor（若有）。
   * 调用方应该用返回值 dispatch 下一步。
   */
  markStepDone(
    id: string,
    index: number,
    outputTailShort: string,
  ): { next?: { target: string; prompt: string; index: number }; chainDone: boolean } {
    const c = this.states.get(id);
    if (!c || c.status !== 'running') return { chainDone: true };
    const step = c.steps[index];
    if (!step) return { chainDone: true };
    step.status = 'done';
    step.endedAt = Date.now();
    step.outputTailShort = outputTailShort.split('\n').slice(-5).join('\n');

    const nextIndex = index + 1;
    if (nextIndex >= c.steps.length) {
      c.status = 'done';
      c.endedAt = Date.now();
      this.archive(id);
      this.events.emit('updated', c);
      return { chainDone: true };
    }
    const nextStep = c.steps[nextIndex]!;
    this.events.emit('updated', c);
    return {
      next: { target: nextStep.target, prompt: nextStep.prompt, index: nextIndex },
      chainDone: false,
    };
  }

  markStepFailed(id: string, index: number, reason: string): void {
    const c = this.states.get(id);
    if (!c || c.status !== 'running') return;
    const step = c.steps[index];
    if (!step) return;
    step.status = 'failed';
    step.endedAt = Date.now();
    step.failureReason = reason;
    // 剩余步骤标 skipped
    for (let i = index + 1; i < c.steps.length; i++) {
      const s = c.steps[i]!;
      if (s.status === 'pending') s.status = 'skipped';
    }
    c.status = 'failed';
    c.endedAt = Date.now();
    this.archive(id);
    this.events.emit('updated', c);
    logger.info('chain failed', { id, step: index, reason });
  }

  cancel(id: string): boolean {
    const c = this.states.get(id);
    if (!c || c.status !== 'running') return false;
    for (const step of c.steps) {
      if (step.status === 'pending') step.status = 'skipped';
      else if (step.status === 'running') {
        step.status = 'cancelled';
        step.endedAt = Date.now();
      }
    }
    c.status = 'cancelled';
    c.endedAt = Date.now();
    this.archive(id);
    this.events.emit('updated', c);
    logger.info('chain cancelled', { id });
    return true;
  }

  listActive(): ChainState[] {
    return [...this.states.values()];
  }

  recentDone(limit = 10): ChainState[] {
    return this.done.slice(0, limit);
  }

  private archive(id: string): void {
    const c = this.states.get(id);
    if (!c) return;
    this.states.delete(id);
    this.done.unshift(c);
    if (this.done.length > ChainManager.DONE_LIMIT) {
      this.done = this.done.slice(0, ChainManager.DONE_LIMIT);
    }
  }
}

export const chainManager = new ChainManager();
