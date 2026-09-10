/**
 * check:boot —— 本仓库的「加载期冒烟」（`agent bootcheck` 会自动发现并调用它）。
 *
 * 干两件 typecheck 挡不住的事：
 *  1. **真 import 一遍每个 workspace 包的入口**：顶层 throw、循环 import、模块级副作用炸掉、
 *     导出名写错这类「编译过但加载即崩」的问题，只有真加载才暴露。
 *  2. **查本仓库自己的跨文件契约**：`protocol.ts` 的 op 字面量 ↔ `server.ts` 的 case 分支
 *     必须双向对齐。CLAUDE.md「扩展时的小坑」第 4 条要求新增 CLI 命令要同时改
 *     cli.ts / server.ts / protocol.ts —— 漏一处的后果是「CLI 发了个 server 不认的 op」，
 *     typecheck 未必报（op 只是字符串字面量联合的一支），但运行时那条命令直接不可用。
 *
 * 刻意**不** import `apps/daemon/src/index.ts`：它底部就调 main()，import 等于把 daemon 起起来。
 * 这也是这类脚本的通用注意点——冒烟要「只组装、不启动」，见 docs/features.md §34。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * 按**源码相对路径**导入，不按包名：根 package.json 没有把这些 workspace 包列为依赖
 * （只有 apps/daemon 列了），从 scripts/ 按包名 import 会 ERR_MODULE_NOT_FOUND。
 * 走源码路径还更贴近真相——真加载的就是这些 .ts。
 */
const PACKAGE_ENTRIES = [
  'packages/orchestrator/src/index.ts',
  'packages/host-mac/src/index.ts',
  'packages/framework/src/index.ts',
  'packages/im-lark/src/index.ts',
  'packages/im-wecom/src/index.ts',
] as const;

const failures: string[] = [];

async function importEntries(): Promise<void> {
  for (const mod of PACKAGE_ENTRIES) {
    const t0 = Date.now();
    try {
      const ns = await import(pathToFileURL(join(ROOT, mod)).href);
      const n = Object.keys(ns).length;
      if (n === 0) failures.push(`${mod} 导入成功但零导出——入口可能没接上`);
      else console.log(`  ✓ ${mod} → ${n} exports (${Date.now() - t0}ms)`);
    } catch (e) {
      failures.push(`import ${mod} 失败：${(e as Error).stack ?? (e as Error).message}`);
    }
  }
}

/**
 * 抽字符串字面量集合——够用且零依赖；两侧都用同一套正则，漏抽会体现在双向差集里。
 *
 * ⚠ 这是**字符串扫描，不是语义分析**。已知边界：被注释掉的 `case 'x':` 会被算进来；
 * op 若改成类型别名/模板字面量声明就抽不到；无关字符串里出现 `case 'x'` 会误报。
 * 当前 protocol.ts 是字面量联合、server.ts 是纯 switch/case，所以成立——
 * **这两个文件结构大改时，要重新人工核对这套正则还准不准**，别当成强保证。
 */
function literals(file: string, re: RegExp): Set<string> {
  const src = readFileSync(file, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(re)) out.add(m[1]!);
  return out;
}

function checkControlOpContract(): void {
  const base = join(ROOT, 'packages', 'framework', 'src', 'control');
  const declared = literals(join(base, 'protocol.ts'), /\bop:\s*'([a-z0-9.\-_]+)'/g);
  const handled = literals(join(base, 'server.ts'), /\bcase\s*'([a-z0-9.\-_]+)'/g);

  const missing = [...declared].filter((op) => !handled.has(op)).sort();
  const orphan = [...handled].filter((op) => !declared.has(op)).sort();

  if (missing.length) {
    failures.push(
      `protocol.ts 声明了 op 但 server.ts 没有 case：${missing.join(', ')}\n` +
        `    → CLI 发这些 op 会被 server 当未知请求；补 server.ts 的分支（CLAUDE.md 扩展坑 #4）`,
    );
  }
  if (orphan.length) {
    failures.push(
      `server.ts 有 case 但 protocol.ts 没声明该 op：${orphan.join(', ')}\n` +
        `    → 要么是 op 拼错了，要么忘了在 protocol.ts 加类型（CLI 侧写不出这个请求）`,
    );
  }
  if (!missing.length && !orphan.length) {
    console.log(`  ✓ control op 契约对齐（protocol ${declared.size} 个 op ↔ server ${handled.size} 个 case）`);
  }
}

console.log('check:boot —— 加载期冒烟');
await importEntries();
checkControlOpContract();

if (failures.length) {
  console.error('\n✗ check:boot FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('✓ check:boot OK');
