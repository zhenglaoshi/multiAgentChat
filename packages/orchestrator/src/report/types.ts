/**
 * 报告模块的共享类型。
 * 单独成文件是为了让 `args.ts`（参数/日期解析）与 `collect.ts`（采集）都只**单向**依赖它
 * ——两个纯逻辑文件互相 import 即便当前是 `import type`（编译期擦除、无运行时循环），
 * 也是个隐患：哪天有人顺手连值一起导入就成真循环了。
 */
export type ReportWindow = 'day' | 'week' | 'month' | 'year';
