/**
 * 测试专用入口（子路径导出 `multiagent-host-api/testing`）。
 *
 * 与生产入口 `index.ts` **分开**：清空宿主注册这种操作只该出现在测试里，
 * 从主入口导出等于给任何拿到执行权的代码留一个「让终端操作全线抛错」的开关。
 * 这道边界挡的是「按包名 import」，挡不住跨包深相对路径 —— 见 registry.ts 里的说明。
 */
export { unsafeResetHostRegistry as resetHostForTests } from './registry.js';
