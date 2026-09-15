/**
 * 终端 tab 类型 —— 定义已上移到 `multiagent-host-api`（宿主无关契约），这里只做 re-export，
 * 保证 host-mac 内部与上层用的是**同一批类型**，也让老调用点
 * （`import type { TerminalTab } from 'multiagent-host-mac'`）继续可用。
 */
export type { SendResult, TerminalTab, TerminalWindow } from 'multiagent-host-api';
