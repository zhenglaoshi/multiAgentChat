import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetLarkBotsForTest,
  botIdForChat,
  namespaceChatId,
  parseLarkBotProfiles,
  registerLarkClient,
  resolveLarkClient,
  toNativeChatId,
} from '../packages/im-lark/src/lark/bots.js';

const BASE = { LARK_APP_ID: 'cli_local', LARK_APP_SECRET: 'sec_local' };

afterEach(() => {
  __resetLarkBotsForTest();
  delete process.env['LARK_BOT_STAFF_APP_ID'];
  delete process.env['LARK_BOT_STAFF_APP_SECRET'];
  delete process.env['LARK_BOT_STAFF_ROLE'];
});

describe('parseLarkBotProfiles', () => {
  it('只配默认 → 一个 local / tabs', () => {
    const { profiles, skipped } = parseLarkBotProfiles(BASE);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: 'local', role: 'tabs', appId: 'cli_local' });
    expect(skipped).toEqual([]);
  });

  it('LARK_BOT_STAFF_* → 附属 bot staff，role 识别 digital-staff', () => {
    const { profiles } = parseLarkBotProfiles({
      ...BASE,
      LARK_BOT_STAFF_APP_ID: 'cli_staff',
      LARK_BOT_STAFF_APP_SECRET: 'sec_staff',
      LARK_BOT_STAFF_ROLE: 'digital-staff',
      LARK_BOT_STAFF_LABEL: '数字员工',
    });
    expect(profiles.map((p) => p.id)).toEqual(['local', 'staff']);
    expect(profiles[1]).toMatchObject({ role: 'digital-staff', label: '数字员工', appId: 'cli_staff' });
  });

  it('缺 secret / 保留字 id → 跳过并给原因', () => {
    const { profiles, skipped } = parseLarkBotProfiles({
      ...BASE,
      LARK_BOT_FOO_APP_ID: 'cli_foo',
      LARK_BOT_WECOM_APP_ID: 'cli_w',
      LARK_BOT_WECOM_APP_SECRET: 's',
    });
    expect(profiles.map((p) => p.id)).toEqual(['local']);
    expect(skipped.join('\n')).toMatch(/缺 LARK_BOT_FOO_APP_SECRET/);
    expect(skipped.join('\n')).toMatch(/保留字/);
  });

  it('留空的 APP_ID（.env.example 占位）静默忽略', () => {
    const { profiles, skipped } = parseLarkBotProfiles({ ...BASE, LARK_BOT_STAFF_APP_ID: '' });
    expect(profiles).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('下划线 id 转成连字符，role 默认 tabs', () => {
    const { profiles } = parseLarkBotProfiles({
      ...BASE,
      LARK_BOT_MY_BOT_APP_ID: 'a',
      LARK_BOT_MY_BOT_APP_SECRET: 'b',
    });
    expect(profiles[1]).toMatchObject({ id: 'my-bot', role: 'tabs', label: 'my-bot' });
  });
});

describe('chatId 命名空间', () => {
  function withStaff(): void {
    process.env['LARK_BOT_STAFF_APP_ID'] = 'cli_staff';
    process.env['LARK_BOT_STAFF_APP_SECRET'] = 'sec';
    __resetLarkBotsForTest();
  }

  it('默认 bot 不加前缀（老数据兼容）', () => {
    expect(namespaceChatId('local', 'oc_1')).toBe('oc_1');
    expect(namespaceChatId('staff', 'oc_1')).toBe('staff:oc_1');
  });

  it('toNativeChatId 只剥已注册 bot 的前缀；wecom:/未知前缀原样', () => {
    withStaff();
    expect(toNativeChatId('staff:oc_1')).toBe('oc_1');
    expect(toNativeChatId('oc_1')).toBe('oc_1');
    expect(toNativeChatId('wecom:user:abc')).toBe('wecom:user:abc');
    expect(toNativeChatId('nobody:oc_1')).toBe('nobody:oc_1');
  });

  it('botIdForChat', () => {
    withStaff();
    expect(botIdForChat('staff:oc_1')).toBe('staff');
    expect(botIdForChat('oc_1')).toBe('local');
    expect(botIdForChat('wecom:user:abc')).toBe('local');
  });

  it('resolveLarkClient：有前缀且已注册 → 那个 client；否则 fallback', () => {
    withStaff();
    type LarkClient = Parameters<typeof registerLarkClient>[1];
    const local = { tag: 'local' } as unknown as LarkClient;
    const staff = { tag: 'staff' } as unknown as LarkClient;
    registerLarkClient('local', local);
    expect(resolveLarkClient(local, 'staff:oc_1')).toBe(local); // staff 没注册 → fallback
    registerLarkClient('staff', staff);
    expect(resolveLarkClient(local, 'staff:oc_1')).toBe(staff);
    expect(resolveLarkClient(local, 'oc_1')).toBe(local);
    expect(resolveLarkClient(local, 'wecom:user:x')).toBe(local);
  });
});

describe('notifier 的 patchCard 按 chatId 选 bot（回归：附属 tabs bot 的卡发出后不刷新）', () => {
  it('源码里 notifier 不再有裸 patchCard(client, …)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../packages/im-lark/src/monitor/notifier.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/patchCard\(\s*client\s*,/);
    expect((src.match(/patchCard\(\s*resolveLarkClient\(client,/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe('import im-lark 会加载 cwd 下的 .env（回归：多 bot 改造后 dotenv 无人引入，daemon 启动崩溃循环）', () => {
  it('子进程在临时目录 import 包入口后，process.env 里能看到 .env 的值', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'mchat-dotenv-'));
    try {
      writeFileSync(join(dir, '.env'), 'LARK_APP_ID=cli_from_dotenv\nLARK_APP_SECRET=s\n');
      const { fileURLToPath } = await import('node:url');
      const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
      const entry = join(root, 'packages/im-lark/src/lark/bots.ts');
      const tsx = join(root, 'node_modules/.bin/tsx');
      const env = { ...process.env };
      delete env['LARK_APP_ID'];
      delete env['LARK_APP_SECRET'];
      const out = execFileSync(tsx, ['-e', `import(${JSON.stringify(entry)}).then(() => process.stdout.write(String(process.env.LARK_APP_ID)))`], { cwd: dir, env, encoding: 'utf8' });
      expect(out.trim().split('\n').pop()).toBe('cli_from_dotenv');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('dotenv 必须是 im-lark 的显式依赖（回归：曾靠 ~/node_modules 幽灵解析，换机器即崩）', () => {
  it('package.json 声明了 dotenv，且从 im-lark 解析到的 dotenv 在仓库内', async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { fileURLToPath } = await import('node:url');
    const pkgUrl = new URL('../packages/im-lark/package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['dotenv']).toBeTruthy();
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const resolved = createRequire(pkgUrl).resolve('dotenv');
    expect(resolved.startsWith(repoRoot)).toBe(true);
  });
});
