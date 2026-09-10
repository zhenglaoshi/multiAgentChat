/**
 * 全局 pre-push hook 的 opt-in 白名单 —— **按内容授信，不按路径授信**。
 *
 * 为什么要白名单：hook 会**自动执行仓库里的 npm script**。这是真实的供应链面
 * （security-reviewer 点过）——所以默认谁都不跑，只对你显式登记过的仓库跑。
 *
 * 为什么光有路径白名单不够（这条是审出来的 high）：路径不变、内容随便换。日常最容易踩的
 * 是「在自己常用的仓库目录里 checkout 同事的 PR / `git worktree add` / 拉了别人控制的
 * submodule，然后 push 了个无关分支」——此刻磁盘上的 `package.json` 里那几个固定名字的
 * script 已经是别人写的了，hook 会把它当「项目自己的脚本」原样跑，还继承你 shell 的全部环境变量。
 * 脚本**名字**受控（plan.ts 只挑固定几个名字）不等于脚本**内容**受控。
 *
 * 所以登记时对「将来真会被执行的那几条命令」做快照 hash（TOFU，Trust-On-First-Use）：
 * 内容变了 → hook **不跑**，打印提示让你重新 `agent bootcheck allow` 确认，但**不堵 push**
 * （fail-open：这是质量闸不是安全闸，堵死会让人直接卸掉它，反而更糟）。
 *
 * 指纹范围（两条旁路是审出来的，都已纳入；第三条纳不进来，如实标成已知限制）：
 *  1. **`pre<name>` / `post<name>` 也必须算进去**。npm / pnpm / yarn **三者都**会对任意
 *     脚本名自动跑前后钩子（实测：加一个 `precheck:boot`，`npm run check:boot` 会先跑它）。
 *     只 hash `check:boot` 的话，攻击者不碰它、只新增 `precheck:boot` 就能让指纹不变而代码换掉，
 *     而且 `allow` 打印给人「过目」的清单里根本看不到这个键 —— 人在过目那一刻就是瞎的。
 *  2. **命令指向的仓库内脚本文件，要连内容一起 hash**。`check:boot: tsx scripts/check-boot.ts`
 *     这行不变、`scripts/check-boot.ts` 内容被换掉，指纹照样不变 —— 那 TOFU 信的就只是个指针。
 *  3. ⚠ **已知限制，没闭合**：只 hash 命令里直接出现的那一层文件，**不追传递依赖**
 *     （本仓库的 `check-boot.ts` 自己就 import 了五个包的整棵树）。要彻底闭合等于把整棵源码树
 *     都 hash，那已经是另一个东西（"信任这个 commit"）。所以这道门的诚实定位是：
 *     **把「同一目录被换内容」从「静默执行」变成「要么指纹不符被挡下、要么你亲眼过目过」**，
 *     而不是「能改仓库里任意文件的人也改不动被执行的内容」。`allow` 的警告文案里照实写了这条。
 *
 * 为什么存在 ~/.multiagent-chat/ 而不是仓库的 ./data/：hook 从**任意仓库的 cwd** 调
 * `agent bootcheck`，`resolve('./data/...')` 那套（daemon 的约定）在这里读不到。
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ALL_KNOWN_SCRIPTS } from './plan.js';

export interface BootCheckEntry {
  /** 仓库根（绝对路径） */
  repo: string;
  /** 登记那一刻、这个仓库里「会被执行的那几条 script 命令」的 sha256（见 scriptsFingerprint） */
  scriptsHash: string;
  /** 登记时间（ISO） */
  approvedAt: string;
}

export interface BootCheckConfig {
  hookRepos: BootCheckEntry[];
}

export function defaultConfigPath(): string {
  return join(homedir(), '.multiagent-chat', 'bootcheck.json');
}

/**
 * 归一化仓库路径：解析 symlink + 转绝对路径 + 去尾斜杠。
 *
 * 必须解 symlink：登记时用的是你 shell 的 cwd 字符串，校验时用的是
 * `git rev-parse --show-toplevel`，路径里有 symlink（macOS 的 /tmp → /private/tmp、
 * iCloud 同步目录）时两者是不同字符串 → 白名单**静默失配**（表现为「不在白名单，跳过」，
 * 你以为在保护其实每次都跳过）。路径不存在时退回纯字符串归一化。
 * 大小写不敏感文件系统（APFS 默认）下大小写不同的写法仍会失配，实践中少见，不处理。
 */
export function normalizeRepo(root: string): string {
  let abs = resolve(root);
  try {
    abs = realpathSync(abs);
  } catch {
    /* 路径还不存在（测试/已删仓库）→ 用 resolve 的结果 */
  }
  return abs.length > 1 && abs.endsWith('/') ? abs.slice(0, -1) : abs;
}

/** 单个文件最多 hash 这么多字节——防着有人塞个巨大文件把 push 拖死。 */
const MAX_HASHED_FILE_BYTES = 1_000_000;

/**
 * 会被自动执行的 script 名（含 npm/pnpm/yarn 的 `pre`/`post` 前后钩子），按存在与否过滤。
 * 只取这几个名字（而不是整个 package.json）是刻意的：改 `test` 或加依赖不该弹提示，
 * 否则噪音大到没人看——只有「真会被自动执行的东西变了」才需要你重新过目。
 */
export function relevantScriptNames(scripts: Record<string, string> | undefined): string[] {
  const s = scripts ?? {};
  const names: string[] = [];
  for (const base of ALL_KNOWN_SCRIPTS) {
    for (const name of [`pre${base}`, base, `post${base}`]) {
      if (typeof s[name] === 'string' && s[name]!.trim() !== '') names.push(name);
    }
  }
  return names;
}

/** 一条命令里最多锁这么多文件；超了在指纹里记总数，见 referencedRepoFiles 注释。 */
const MAX_REFERENCED_FILES = 20;
/** 省略扩展名时按 Node/tsx 的习惯补这些 */
const IMPLICIT_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx'] as const;
/** 只有 JS 运行时才把「裸词」也当路径（`node noext`）——否则 `npm run build` 的 `build` 会被当路径 */
const JS_RUNTIMES = /^(node|tsx|ts-node|babel-node|bun|deno)$/;

/**
 * 按引号分词（保留引号内的空格）。`node "scripts/check boot.ts"` 必须切成两个 token，
 * 而不是三个 —— 朴素 `split(/\s+/)` 会把带空格的路径拆散、再也拼不回来。
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** 目录入口解析最多递归这么深（`main` 指目录、目录里又靠 `main` 指下去）——防环。 */
const MAX_ENTRY_DEPTH = 4;

/**
 * 把一个候选字符串解析成仓库内的真实文件（相对路径）；解析不到返回 null。
 *
 * 目录分支必须**递归**（这条是安全评审第四轮抓出来的）：真实项目里
 * `"main": "lib/index"`（省略扩展名 + 指子目录）和「只有 `exports` 没有 `main`」
 * （2020 年后的包基本都这样）都很常见，而这两种下 `node .` 的真实入口原先完全解析不到
 * → 那条命令干脆不进指纹 → 换掉入口文件内容指纹照旧 → TOFU 形同虚设。
 */
function resolveRepoFile(repo: string, candidate: string, depth = 0): string | null {
  if (depth > MAX_ENTRY_DEPTH) return null;

  const inRepo = (abs: string): string | null => {
    const rel = relative(repo, abs);
    // 必须留在仓库内（防 ../ 逃逸），且必须是个普通文件
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    try {
      return statSync(abs).isFile() ? rel : null;
    } catch {
      return null;
    }
  };

  const abs = join(repo, candidate);
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(abs);
  } catch {
    st = null;
  }

  if (st?.isFile()) return inRepo(abs);

  if (st?.isDirectory()) {
    // `node .` / `node ./scripts` —— 按 Node 的解析：package.json 的 main / exports，否则 index.*
    // ⚠ 只认 `main`，**刻意不读 `exports`**（这条是安全评审第五轮抓出来的，我用真 node v22 实测过）：
    //   `node <目录>` 这种 CLI 直接执行目录的场景，Node **根本不看 exports** —— 只认 main，
    //   main 缺失/解析不到就退化成 index.js。exports 只在被 require()/import 当模块引用时才生效。
    //   之前"顺手支持 exports"反而制造了一个更隐蔽的洞：仓库只要有 exports（大量 2020 年后的包
    //   都有，哪怕只是给外部库消费者用）+ 没有可用 main + 有 index.js（Node 的默认兜底），
    //   就会命中 exports 目标、提前 return、**永远不再试 index.js** → 锁的是一个真实 node 从不执行
    //   的文件，而 `allow` 清单还显示「已锁定」、unresolved 也是空的 → 伪造出「已被保护」的假象，
    //   比"看不出没锁"更糟。真正会被执行的 index.js 可以被任意替换而指纹不变。
    const entries: string[] = [];
    try {
      const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8')) as { main?: unknown };
      if (typeof pkg.main === 'string') entries.push(pkg.main);
    } catch {
      /* 没有 package.json 或坏了 → 只试 index.* */
    }
    for (const entry of entries) {
      // 递归：main 可能省略扩展名、指向子目录、甚至再指一层
      const hit = resolveRepoFile(repo, join(relative(repo, abs), entry), depth + 1);
      if (hit) return hit;
    }
    for (const ext of IMPLICIT_EXTS) {
      const hit = inRepo(join(abs, `index${ext}`));
      if (hit) return hit;
    }
    return null;
  }

  // `node ./noext` —— 省略扩展名
  for (const ext of IMPLICIT_EXTS) {
    const hit = inRepo(abs + ext);
    if (hit) return hit;
  }
  return null;
}

/**
 * 从一条命令里挑出「会被执行到的仓库内文件」（相对路径）。
 *
 * 这个函数被安全评审连着抓了两轮，踩过的坑都写在这：
 *  - `node .` / `node ./dist`：**目录引用**，要按 Node 的解析规则找到 `main`/`index.*`；
 *  - `node ./noext`：**省略扩展名**，要补 `.js/.mjs/.cjs/.ts/.tsx`；
 *  - `node -e "require('./payload.js')"`：路径**嵌在引号/语法里**，要扫整串的路径片段；
 *  - `webpack --config=webpack.prod.js`：路径**跟在 `=` 后面**，不能因为 token 以 `-` 开头就整条跳过；
 *  - `node "scripts/check boot.ts"`：**引号内含空格**，所以自己分词而不是 `split(/\s+/)`；
 *  - **上限不能提前退出**：原先扫到第 5 个存在的文件就 break，攻击者只要在命令里先垫 5 个正常文件、
 *    把真载荷排在后面，那个文件就永远不进指纹（改它也测不出来）。现在扫全部、排序后取前
 *    `MAX_REFERENCED_FILES` 个，且**把总数写进指纹**，垫参数会让总数变→指纹变→要求重新确认。
 *
 * ⚠ 仍未覆盖（如实记，`allow` 的警告文案里也写了）：非 JS 运行时命令里的裸词路径、
 * 以及**传递依赖**（被指向的脚本 import 的其它文件）。
 */
export interface CommandRefs {
  /** 已定位到、会被连内容一起锁的文件（仓库相对路径） */
  files: string[];
  /**
   * 认得出指向仓库内某个东西、但**没能定位到入口文件**的候选（比如 `node .` 而 package.json
   * 的入口声明是我们不认识的形态）。这些**没有内容锁**，必须显式告诉人 —— 否则 `allow` 的清单里
   * 只是"不出现 [连内容一起锁]"，人会误以为这条命令压根没有仓库内文件依赖。
   */
  unresolved: string[];
}

/** 见 referencedRepoFiles；这个版本额外回报「定位不到入口」的候选。 */
export function analyzeCommandRefs(command: string, repo: string): CommandRefs {
  const tokens = tokenizeCommand(command);
  const program = tokens[0] ? basename(tokens[0]) : '';
  const isRuntime = JS_RUNTIMES.test(program);

  const candidates = new Set<string>();
  for (const tok of tokens.slice(1)) {
    if (tok.startsWith('-')) {
      // --config=webpack.prod.js：等号后面那截才是路径
      const eq = tok.indexOf('=');
      if (eq > 0) candidates.add(tok.slice(eq + 1));
      continue;
    }
    candidates.add(tok);
  }
  // 路径嵌在引号/括号/require() 里：扫整串里以 ./ ../ 开头、或含 / 的片段
  for (const m of command.matchAll(/\.{1,2}\/[^\s'"`)]+|[\w@.-]+\/[^\s'"`)]+/g)) {
    candidates.add(m[0]!);
  }

  const found = new Set<string>();
  const unresolved = new Set<string>();
  for (const raw of candidates) {
    const cand = raw.trim();
    if (!cand || cand.startsWith('/')) continue;
    const pathLike = cand === '.' || /[./]/.test(cand);
    if (!pathLike) continue;
    // 裸词（无 . 无 /）只在 JS 运行时命令里当路径，否则 `npm run build` 的 build
    // 会去匹配 ./build 产物目录 → 每次构建都变 → 天天弹「重新确认」，没人会再看
    if (!/[./]/.test(cand) && !isRuntime) continue;
    const rel = resolveRepoFile(repo, cand);
    if (rel) {
      found.add(rel);
      continue;
    }
    // 磁盘上确实存在（通常是目录）却定位不到入口 → 记成「没锁住」，让人看得见
    try {
      if (statSync(join(repo, cand)).isDirectory()) unresolved.add(cand);
    } catch {
      /* 压根不存在 → 不是仓库内引用，不用提 */
    }
  }
  return { files: [...found].sort(), unresolved: [...unresolved].sort() };
}

/** 命令里会被执行到的仓库内文件（相对路径）。 */
export function referencedRepoFiles(command: string, repo: string): string[] {
  return analyzeCommandRefs(command, repo).files;
}

/**
 * 「将来真会被执行的命令」的指纹：`名字=命令` + 命令直接指向的仓库内文件的内容 hash，
 * 排序后取 sha256。给了 `repo` 才会 hash 文件内容（纯算指纹的场合可以不给）。
 *
 * 覆盖范围与那条**未闭合的已知限制**见本文件顶部注释第 3 条。
 */
export function scriptsFingerprint(
  scripts: Record<string, string> | undefined,
  repo?: string,
): string {
  const s = scripts ?? {};
  const lines: string[] = [];
  for (const name of relevantScriptNames(s)) {
    const cmd = s[name]!;
    lines.push(`${name}=${cmd}`);
    if (!repo) continue;
    const { files: refs, unresolved } = analyzeCommandRefs(cmd, repo);
    // 总数进指纹：这样「垫参数把真载荷挤出上限」会改变总数 → 指纹变 → 要求重新确认
    lines.push(`refs:${name}=${refs.length}`);
    if (unresolved.length) lines.push(`unresolved:${name}=${unresolved.join(',')}`);
    for (const rel of refs.slice(0, MAX_REFERENCED_FILES)) {
      let fileHash = 'unreadable';
      try {
        const buf = readFileSync(join(repo, rel));
        fileHash = createHash('sha256')
          .update(buf.subarray(0, MAX_HASHED_FILE_BYTES))
          .digest('hex');
      } catch {
        /* 读不到就记成 unreadable —— 与「能读到」天然产生差异，方向安全 */
      }
      lines.push(`file:${rel}=${fileHash}`);
    }
  }
  return createHash('sha256').update(lines.sort().join('\n'), 'utf8').digest('hex');
}

/** 读某个仓库当前的 scripts（读不到就 undefined）——登记与校验共用，保证两边同源。 */
export function readRepoScripts(root: string): Record<string, string> | undefined {
  const pkg = join(normalizeRepo(root), 'package.json');
  if (!existsSync(pkg)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return undefined;
  }
}

/**
 * 算某个仓库当前的指纹 —— **对外只用这一个入口**。
 *
 * 为什么要它：`scriptsFingerprint(scripts, repo?)` 的 repo 是可选的（纯算命令字符串时不需要读盘），
 * 于是调用方漏传第二个参数就会算出「不含文件内容」的另一个指纹 → 永远判 scripts-changed →
 * 这道门静默失效。契约不该靠人记得传参，所以登记与校验都走这个函数。
 */
export function repoFingerprint(repo: string): string {
  return scriptsFingerprint(readRepoScripts(repo), normalizeRepo(repo));
}

export type AllowDecision =
  | { allowed: true; entry: BootCheckEntry }
  /** 没登记过 */
  | { allowed: false; reason: 'not-listed' }
  /** 登记过，但会被执行的脚本内容变了 —— 需要人重新过目 */
  | { allowed: false; reason: 'scripts-changed'; entry: BootCheckEntry; currentHash: string };

/** 纯判定（不读盘）：给定登记表 + 当前指纹，决定这次 hook 该不该跑。 */
export function decideAllowed(
  root: string,
  entries: BootCheckEntry[],
  currentHash: string,
): AllowDecision {
  const target = normalizeRepo(root);
  const entry = entries.find((e) => normalizeRepo(e.repo) === target);
  if (!entry) return { allowed: false, reason: 'not-listed' };
  if (entry.scriptsHash !== currentHash) {
    return { allowed: false, reason: 'scripts-changed', entry, currentHash };
  }
  return { allowed: true, entry };
}

export function readConfig(file = defaultConfigPath()): BootCheckConfig {
  if (!existsSync(file)) return { hookRepos: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hookRepos?: unknown };
    const raw = Array.isArray(parsed.hookRepos) ? parsed.hookRepos : [];
    const entries: BootCheckEntry[] = [];
    for (const item of raw) {
      // 兼容早期只存路径字符串的格式：当成「登记过但没有指纹」→ 指纹对不上，会走
      // scripts-changed 分支要求重新确认。宁可多问一次，也不拿旧格式当无条件放行。
      if (typeof item === 'string') {
        entries.push({ repo: item, scriptsHash: '', approvedAt: '' });
      } else if (item && typeof item === 'object') {
        const e = item as Partial<BootCheckEntry>;
        if (typeof e.repo === 'string') {
          entries.push({
            repo: e.repo,
            scriptsHash: typeof e.scriptsHash === 'string' ? e.scriptsHash : '',
            approvedAt: typeof e.approvedAt === 'string' ? e.approvedAt : '',
          });
        }
      }
    }
    return { hookRepos: entries };
  } catch {
    // 配置坏了 → 空白名单（fail-closed：不自动跑任何仓库的脚本）
    return { hookRepos: [] };
  }
}

export function writeConfig(cfg: BootCheckConfig, file = defaultConfigPath()): void {
  // 目录 0700 / 文件 0600：这里存的是「哪些目录会被自动执行脚本」，别让同机别的账户可读可改
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ hookRepos: cfg.hookRepos }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    chmodSync(dirname(file), 0o700);
    chmodSync(file, 0o600);
  } catch {
    /* 权限收紧是纵深防御，失败不影响功能 */
  }
}

export interface AllowResult {
  repo: string;
  /** 这次登记批准了哪些命令——**打印给人看**，让人知道自己在信什么 */
  approvedCommands: string[];
  /** 之前登记过、且指纹不同（= 这次是「重新确认」而不是首次登记） */
  refreshed: boolean;
  /** 之前就登记过且指纹相同（无变化） */
  unchanged: boolean;
}

/** 登记 / 重新确认一个仓库（幂等）。指纹取自该仓库当前的 package.json。 */
export function allowRepo(root: string, file = defaultConfigPath()): AllowResult {
  const repo = normalizeRepo(root);
  const scripts = readRepoScripts(repo);
  const hash = repoFingerprint(repo);
  const cfg = readConfig(file);
  const prev = cfg.hookRepos.find((e) => normalizeRepo(e.repo) === repo);
  // 把 pre/post 钩子和被一起 hash 的文件都列出来——人过目的那一刻必须看得见全部
  const approvedCommands = relevantScriptNames(scripts).map((n) => {
    const { files, unresolved } = analyzeCommandRefs(scripts![n]!, repo);
    const locked = files.length ? `   [连内容一起锁：${files.join(', ')}]` : '';
    // 定位不到入口就明说，别让人以为「没显示锁定 = 没有文件依赖」
    const gap = unresolved.length
      ? `   [⚠ ${unresolved.join(', ')} 定位不到入口文件，这条没做内容锁]`
      : '';
    return `${n}: ${scripts![n]}${locked}${gap}`;
  });

  if (prev && prev.scriptsHash === hash) {
    return { repo, approvedCommands, refreshed: false, unchanged: true };
  }
  const entry: BootCheckEntry = { repo, scriptsHash: hash, approvedAt: new Date().toISOString() };
  const next = cfg.hookRepos.filter((e) => normalizeRepo(e.repo) !== repo);
  next.push(entry);
  writeConfig({ hookRepos: next }, file);
  return { repo, approvedCommands, refreshed: Boolean(prev), unchanged: false };
}

/** 撤销登记，返回是否真的删掉了。 */
export function denyRepo(root: string, file = defaultConfigPath()): boolean {
  const cfg = readConfig(file);
  const target = normalizeRepo(root);
  const next = cfg.hookRepos.filter((e) => normalizeRepo(e.repo) !== target);
  if (next.length === cfg.hookRepos.length) return false;
  writeConfig({ hookRepos: next }, file);
  return true;
}
