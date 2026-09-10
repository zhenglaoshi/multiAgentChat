/**
 * bootcheck —— 「这份改动还能不能起来」的通用机器门（跨项目，不绑任何框架）。
 *
 * 由来（真实事故，2026-09）：pivotal-parrot 把一个只给内部调用的函数 export 在
 * `modules/<mod>/queries/` 目录里，仓库的 `loadFiles` 会把该目录导出的东西整个塞进 GraphQL
 * `Query` resolver map，SDL 没有同名字段 → `new ApolloServer()` 构造即抛
 * "Query.xxx defined in resolvers, but not in schema"，而 `App.listen` 写在它之后 →
 * GraphQL 与 REST 一起没监听、进程假活。code-reviewer + security-reviewer 都跑过、都漏了：
 * diff 里那行 `+export` 单看完全正常，判它有罪需要的两个事实（自动注册机制 + SDL 缺字段）
 * 都不在 diff 里。同族风险在内部已复发过（blog-backend 用同一份 loader；pigeon 的
 * Subscription 踩过同一条报错并为此写了静态断言测试）。
 *
 * 结论：这类错误编译期 100% 可机器检出，靠 LLM 读 diff 是最差的手段 → 做成确定性门。
 *
 * 分工（关键，别搞混）：
 *  - **本模块只负责发现、调用、判定、如实报告**，不懂任何框架；
 *  - **「精准短路外部连接」只能由各项目自己提供**（一个 `check:boot` 脚本）。因为通用的
 *    「真起一次进程」在 K8s 取 env 的服务上不可靠：本地起会因连不上 DB/MQ 而退出，判 FAIL
 *    是假警报。pivotal 的 `check:schema` 就是这种项目自备脚本的样板（组装 schema 前把
 *    `MQ_URL` 置空，避免抢线上消息）。
 */

/** 这一步是真的「加载期冒烟」，还是只是静态检查（后者挡不住装配期崩溃，报告里必须区分）。 */
export type BootCheckKind = 'boot-smoke' | 'static';

export type BootCheckStatus = 'pass' | 'fail' | 'skipped';

export interface BootCheckStep {
  /** package.json 里的 script 名 */
  script: string;
  /** 实际要执行的命令（含包管理器前缀） */
  command: string;
  kind: BootCheckKind;
}

export interface BootCheckPlan {
  steps: BootCheckStep[];
  /** 有没有一步是真正的加载期冒烟 */
  hasBootSmoke: boolean;
  /** 如实说明：为什么是这些步骤、缺了什么、建议怎么补 */
  note: string;
}

export interface BootCheckStepResult extends BootCheckStep {
  status: Exclude<BootCheckStatus, 'skipped'>;
  exitCode: number | null;
  durationMs: number;
  /** 输出尾部（stdout+stderr 合并，截断）——失败时给人看 */
  outputTail: string;
  /** 超时被杀 */
  timedOut: boolean;
}

export interface BootCheckReport {
  cwd: string;
  status: BootCheckStatus;
  hasBootSmoke: boolean;
  note: string;
  steps: BootCheckStepResult[];
  packageManager: PackageManager;
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm';
