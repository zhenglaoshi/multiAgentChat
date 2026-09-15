/**
 * 宿主注册表 —— 进程级单例。
 *
 * 为什么是注册表而不是逐层依赖注入：宿主能力被 19 个文件、46 处调用点直接用着
 * （watcher / notifier / handlers / commands / server / dashboard…），把 `host` 参数一路穿下去
 * 会波及每一个函数签名，风险远大于收益。项目里已有同款做法（handoff-bridge 的 setter 注入）。
 *
 * 约定：**只在进程的组装根（composition root）调 `setHost()`**
 * —— daemon 的 `main()` 前、CLI 跑 doctor 前，走 `framework/host-bootstrap.ts`。
 * 业务代码一律用 [facade](./facade.ts) 里的同名函数，看不见注册表的存在。
 */

import type { HostController } from './controller.js';

let current: HostController | null = null;

/**
 * 注册宿主实现。重复注册同一个实例是 no-op（多个入口都调 ensureHostRegistered 时会发生）；
 * 换成**不同**实例会抛 —— 一个进程里混用两套宿主一定是 bug。
 */
export function setHost(host: HostController): void {
  if (current && current !== host) {
    throw new Error(
      `HostController 已注册为 ${current.capabilities.displayName}，不能再换成 ${host.capabilities.displayName}`,
    );
  }
  current = host;
}

/** 已注册宿主了吗（探针/诊断里用来决定要不要跳过）。 */
export function hasHost(): boolean {
  return current !== null;
}

/**
 * 取当前宿主。未注册 → 抛带指引的错（而不是 undefined 往下传，最后炸在离现场很远的地方）。
 */
export function getHost(): HostController {
  if (!current) {
    throw new Error(
      'HostController 尚未注册 —— 进程入口需先调 ensureHostRegistered()（framework/host-bootstrap.ts）。',
    );
  }
  return current;
}

/**
 * 仅供测试：清空注册，便于每个用例装不同的假宿主。
 *
 * ⚠ **刻意不从包入口 `index.ts` 导出** —— 它能把进程级宿主清空，等于让后续所有终端操作
 * 抛「尚未注册」。测试从 `multiagent-host-api/testing` 子路径拿。
 *
 * 边界的**真实强度**（别高估）：`exports` 字段只约束「按包名解析」这一条路 ——
 * `from 'multiagent-host-api'` 和 `from 'multiagent-host-api/registry'` 都拿不到它；
 * 但**跨包的深相对路径** `from '../../host-api/src/registry.js'` 照样 import 得到
 * （project references 只管构建顺序，不做封装检查，实测 typecheck 与运行都通过）。
 * 所以这是「约定 + 挡住包名解析」，不是「任何路径都进不来」。要做实得上 ESLint
 * `no-restricted-imports` 禁跨包深导入。
 */
export function unsafeResetHostRegistry(): void {
  current = null;
}
