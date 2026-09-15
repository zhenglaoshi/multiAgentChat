/**
 * workspace · 工作目录相关的**宿主无关**能力：路径解析 / 最近 cwd / 书签 / 目录索引 /
 * git 分支与 worktree / 报告候选仓库集合。
 *
 * 这些原先长在 `multiagent-host-mac` 里（它当时是唯一的"跟机器打交道"的包），但它们只用
 * `node:fs` + `git` 子进程，与 AppleScript / Terminal.app 毫无关系 —— 留在那里会让将来的
 * Windows 宿主为了拿一个书签而把整包 AppleScript 代码拖进去。搬到这里后 host-mac 只剩宿主实现。
 *
 * ⚠ 唯一的平台残留是 `dir-index` 的扫描走 POSIX `find`（见该文件说明），Windows 上先返回空索引。
 */
export * from './paths.js';
export * from './recent-cwds.js';
export * from './bookmarks.js';
export * from './dir-index.js';
export * from './git.js';
export * from './task-workspace.js';
export * from './report-repos.js';
