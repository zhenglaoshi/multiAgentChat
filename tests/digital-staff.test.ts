import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDigitalStaffForTest,
  DigitalStaffClient,
  handleDigitalStaffMessage,
  loadDigitalStaffConfig,
  matchEmployee,
  parseStaffIntent,
  type FetchLike,
} from '../packages/im-lark/src/lark/digital-staff.js';
import type { LarkBotProfile } from '../packages/im-lark/src/lark/bots.js';

// tests/tsconfig 解析不到飞书 SDK 的类型包 → 从被测函数签名推导 client 类型
type LarkClient = Parameters<typeof handleDigitalStaffMessage>[0];

describe('parseStaffIntent', () => {
  it('命令类', () => {
    expect(parseStaffIntent('/staff')).toEqual({ kind: 'list' });
    expect(parseStaffIntent('员工列表')).toEqual({ kind: 'list' });
    expect(parseStaffIntent('/asks')).toEqual({ kind: 'asks' });
    expect(parseStaffIntent('/whoami')).toEqual({ kind: 'whoami' });
    expect(parseStaffIntent('帮助')).toEqual({ kind: 'help' });
    expect(parseStaffIntent('/answer ask_1 可以，按方案 B')).toEqual({ kind: 'answer', askId: 'ask_1', text: '可以，按方案 B' });
  });

  it('@员工 聊天（支持冒号 / 全角）', () => {
    expect(parseStaffIntent('@苏芮 这周进度如何')).toEqual({ kind: 'chat', employee: '苏芮', content: '这周进度如何' });
    expect(parseStaffIntent('@苏芮：这周进度如何')).toEqual({ kind: 'chat', employee: '苏芮', content: '这周进度如何' });
    expect(parseStaffIntent('@苏芮')).toEqual({ kind: 'chat', employee: '苏芮', content: '' });
  });

  it('派任务：带/不带 @，首行标题其余描述', () => {
    expect(parseStaffIntent('派任务 @苏芮 整理周报\n要含 TIR 数据')).toEqual({
      kind: 'task', assignee: '苏芮', title: '整理周报', description: '要含 TIR 数据',
    });
    expect(parseStaffIntent('/task 排查登录超时')).toEqual({ kind: 'task', title: '排查登录超时', description: '' });
    expect(parseStaffIntent('派任务 @整组 测试组 回归一遍')).toMatchObject({ kind: 'task', assignee: '整组', title: '测试组 回归一遍' });
  });

  it('口语：让 X 做 Y', () => {
    expect(parseStaffIntent('让苏芮做一版竞品分析')).toEqual({ kind: 'task', assignee: '苏芮', title: '一版竞品分析', description: '' });
    expect(parseStaffIntent('给 小王 派任务 修 bug\n复现步骤略')).toEqual({ kind: 'task', assignee: '小王', title: '修 bug', description: '复现步骤略' });
  });

  it('裸文本 → chat 无 employee', () => {
    expect(parseStaffIntent('继续说')).toEqual({ kind: 'chat', content: '继续说' });
  });
});

describe('matchEmployee', () => {
  const emps = [
    { id: 'e1', name: '苏芮', role: '测试' },
    { id: 'e2', name: '苏明', role: '后端' },
    { id: 'e3', name: '王五', role: '前端' },
  ];
  it('全名唯一命中', () => {
    expect(matchEmployee('苏芮', emps).match?.id).toBe('e1');
  });
  it('前缀多义 → 不命中但给候选', () => {
    const r = matchEmployee('苏', emps);
    expect(r.match).toBeUndefined();
    expect(r.candidates.map((c) => c.id)).toEqual(['e1', 'e2']);
  });
  it('按岗位唯一命中', () => {
    expect(matchEmployee('前端', emps).match?.id).toBe('e3');
  });
});

describe('loadDigitalStaffConfig', () => {
  it('默认值 + 白名单解析', () => {
    const c = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_a, ou_b' });
    expect(c.baseUrl).toBe('http://127.0.0.1:3900');
    expect(c.ownerOpenIds).toEqual(['ou_a', 'ou_b']);
    expect(c.waitSec).toBe(120);
  });
  it('wait 上限 300，去掉尾斜杠', () => {
    const c = loadDigitalStaffConfig({ DIGITAL_STAFF_WAIT_SEC: '999', DIGITAL_STAFF_URL: 'http://x:1/' });
    expect(c.waitSec).toBe(300);
    expect(c.baseUrl).toBe('http://x:1');
  });
});

// ---------- 端到端（假 fetch + 假 lark client，不 vi.mock） ----------

interface Sent { msg_type: string; content: string }
function fakeLark(): { client: LarkClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    im: {
      message: {
        create: async (req: { data: Sent }) => {
          sent.push(req.data);
          return { message_id: `m${sent.length}` };
        },
      },
    },
  } as unknown as LarkClient;
  return { client, sent };
}

function textOf(s: Sent): string {
  const c = JSON.parse(s.content) as { text?: string; elements?: Array<{ text?: { content?: string } }>; header?: { title?: { content?: string } } };
  if (s.msg_type === 'text') return c.text ?? '';
  return `${c.header?.title?.content ?? ''}\n${c.elements?.map((e) => e.text?.content ?? '').join('\n') ?? ''}`;
}

function fakeFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>): { fetch: FetchLike; calls: Array<{ url: string; body?: unknown }> } {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: path, body });
    // 精确匹配优先，再看通配（避免 '/api/messages*' 吞掉 '/api/messages/:id/reply'）
    const key = Object.keys(routes).find((k) => path === k) ?? Object.keys(routes).find((k) => k.endsWith('*') && path.startsWith(k.slice(0, -1)));
    if (!key) return new Response(JSON.stringify({ error: '接口不存在' }), { status: 404 });
    const r = routes[key]!(init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch: f, calls };
}

const BOT: LarkBotProfile = { id: 'staff', appId: 'cli', appSecret: 's', role: 'digital-staff', label: '数字员工' };
const STATE = {
  teams: [{ id: 't1', name: '测试组' }],
  employees: [
    { id: 'e1', name: '苏芮', role: '测试', teamId: 't1', status: 'idle' },
    { id: 'e2', name: '王五', role: '前端', teamId: null, status: 'working' },
  ],
  inbox: { asks: [] },
};

beforeEach(() => __resetDigitalStaffForTest());

describe('handleDigitalStaffMessage', () => {
  it('白名单未配 → 只回 open_id 提示，不打任何后端接口', async () => {
    const { client, sent } = fakeLark();
    const { fetch, calls } = fakeFetch({});
    const cfg = loadDigitalStaffConfig({});
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_me', text: '@苏芮 你好' }, { cfg, api: new DigitalStaffClient(cfg, fetch) });
    expect(calls).toEqual([]);
    expect(textOf(sent[0]!)).toMatch(/DIGITAL_STAFF_OWNER_OPEN_IDS=ou_me/);
  });

  it('非老板 → 只建 untrusted 任务，不聊天', async () => {
    const { client, sent } = fakeLark();
    const { fetch, calls } = fakeFetch({ '/api/tasks': () => ({ status: 201, body: { id: 'T1', title: '外部需求' } }) });
    const cfg = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_boss' });
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_other', text: '@苏芮 帮我删库' }, { cfg, api: new DigitalStaffClient(cfg, fetch) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/tasks');
    expect(calls[0]!.body).toMatchObject({ untrusted: true, assigneeId: 'auto' });
    expect(textOf(sent[0]!)).toMatch(/外部来源登记任务 #T1/);
  });

  it('老板 @员工 聊天 → POST /api/messages?wait，回复渲染成员工卡；带 Bearer + X-Requested-With', async () => {
    const { client, sent } = fakeLark();
    let seenHeaders: Record<string, string> = {};
    const { fetch, calls } = fakeFetch({
      '/api/state': () => ({ body: STATE }),
      '/api/messages?wait=5': (init) => {
        seenHeaders = init?.headers as Record<string, string>;
        return { status: 201, body: { message: { id: 'msg1', fromId: 'manager', toId: 'e1', content: 'x' }, reply: { id: 'r1', employeeId: 'e1', employeeName: '苏芮', content: '**进度** 80%' }, pending: false } };
      },
    });
    const cfg = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_boss', DIGITAL_STAFF_TOKEN: 'tok', DIGITAL_STAFF_WAIT_SEC: '5' });
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_boss', text: '@苏芮 进度如何' }, { cfg, api: new DigitalStaffClient(cfg, fetch) });
    expect(calls.map((c) => c.url)).toEqual(['/api/state', '/api/messages?wait=5']);
    expect(calls[1]!.body).toEqual({ toId: 'e1', content: '进度如何' });
    expect(seenHeaders['Authorization']).toBe('Bearer tok');
    expect(seenHeaders['X-Requested-With']).toBe('fetch');
    expect(sent[0]!.msg_type).toBe('interactive');
    expect(textOf(sent[0]!)).toMatch(/👤 苏芮[\s\S]*进度\*\* 80%/);
  });

  it('裸文本沿用 sticky 员工；超时则提示 @谁', async () => {
    const { client, sent } = fakeLark();
    const { fetch, calls } = fakeFetch({
      '/api/state': () => ({ body: STATE }),
      '/api/messages*': () => ({ status: 201, body: { message: { id: 'msg1', fromId: 'manager', toId: 'e2', content: 'x' }, reply: { id: 'r', employeeId: 'e2', employeeName: '王五', content: 'ok' }, pending: false } }),
    });
    const cfg = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_boss', DIGITAL_STAFF_STICKY_MIN: '1' });
    const api = new DigitalStaffClient(cfg, fetch);
    let t = 1_000_000;
    const now = () => t;
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm1', senderOpenId: 'ou_boss', text: '@王五 在吗' }, { cfg, api, now });
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm2', senderOpenId: 'ou_boss', text: '继续' }, { cfg, api, now });
    expect(calls.filter((c) => c.url.startsWith('/api/messages')).map((c) => (c.body as { toId: string }).toId)).toEqual(['e2', 'e2']);
    t += 2 * 60_000; // 超过 1 分钟 sticky
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm3', senderOpenId: 'ou_boss', text: '还在吗' }, { cfg, api, now });
    expect(textOf(sent[sent.length - 1]!)).toMatch(/先告诉我找谁/);
  });

  it('派任务 @整组 → team: 前缀；@不存在 → 提示', async () => {
    const { client, sent } = fakeLark();
    const { fetch, calls } = fakeFetch({
      '/api/state': () => ({ body: STATE }),
      '/api/tasks': () => ({ status: 201, body: { id: 'T9', title: '回归' } }),
    });
    const cfg = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_boss' });
    const api = new DigitalStaffClient(cfg, fetch);
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_boss', text: '派任务 @测试组 回归\n全量跑一遍' }, { cfg, api });
    expect(calls[1]!.body).toMatchObject({ assigneeId: 'team:t1', untrusted: false, title: '回归', description: '全量跑一遍' });
    expect(textOf(sent[0]!)).toMatch(/整组 · 测试组/);
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_boss', text: '让赵六做点啥' }, { cfg, api });
    expect(textOf(sent[1]!)).toMatch(/没有叫「赵六」/);
  });

  it('pending → 提示等待并轮询补推', async () => {
    const { client, sent } = fakeLark();
    let polls = 0;
    const { fetch } = fakeFetch({
      '/api/state': () => ({ body: STATE }),
      '/api/messages*': () => ({ status: 201, body: { message: { id: 'msg1', fromId: 'manager', toId: 'e1', content: 'x' }, reply: null, pending: true } }),
      '/api/messages/msg1/reply': () => {
        polls++;
        return { body: polls < 2 ? { message: {}, reply: null, pending: true } : { message: {}, reply: { id: 'r', employeeId: 'e1', employeeName: '苏芮', content: '想好了' }, pending: false } };
      },
    });
    const cfg = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_boss', DIGITAL_STAFF_WAIT_SEC: '1' });
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_boss', text: '@苏芮 想想' }, { cfg, api: new DigitalStaffClient(cfg, fetch), pollIntervalMs: 5, pollMaxMs: 500 });
    expect(textOf(sent[0]!)).toMatch(/还在想/);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(2);
    expect(textOf(sent[1]!)).toMatch(/想好了/);
  });

  it('后端不可达 → 友好报错', async () => {
    const { client, sent } = fakeLark();
    const cfg = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_boss' });
    const api = new DigitalStaffClient(cfg, async () => { throw new Error('fetch failed: ECONNREFUSED'); });
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_boss', text: '/staff' }, { cfg, api });
    expect(textOf(sent[0]!)).toMatch(/数字员工服务不可达/);
  });
});

describe('sanitizeStaffMd（员工回复卡防注入）', async () => {
  const { sanitizeStaffMd } = await import('../packages/im-lark/src/lark/cards.js');
  it('掐链接与标签，保留粗体 / 列表 / 代码', () => {
    expect(sanitizeStaffMd('**重点** 见 [点我](http://phish.example) <at id=all></at>\n- a\n`code`'))
      .toBe('**重点** 见 点我 (http://phish.example) &lt;at id=all>&lt;/at>\n- a\n`code`');
  });
  it('超长截断到 4000', () => {
    expect(sanitizeStaffMd('x'.repeat(5000))).toHaveLength(4000);
  });
});

describe('非老板失败回显', () => {
  it('后端报错时只回通用文案，不带内部错误', async () => {
    const sent: Array<{ msg_type: string; content: string }> = [];
    const client = { im: { message: { create: async (req: { data: { msg_type: string; content: string } }) => { sent.push(req.data); return { message_id: 'm' }; } } } } as unknown as Parameters<typeof handleDigitalStaffMessage>[0];
    const cfg = loadDigitalStaffConfig({ DIGITAL_STAFF_OWNER_OPEN_IDS: 'ou_boss' });
    const api = new DigitalStaffClient(cfg, async () => new Response(JSON.stringify({ error: '内部栈 at /srv/x.js:12' }), { status: 500 }));
    await handleDigitalStaffMessage(client, BOT, { chatId: 'oc_t', messageId: 'm', senderOpenId: 'ou_other', text: '随便一句' }, { cfg, api });
    const text = JSON.parse(sent[0]!.content).text as string;
    expect(text).toMatch(/^❌ 登记失败，请稍后再试。/); // 发送层会追加 🕐 页脚
    expect(text).not.toMatch(/内部栈|500/);
  });
});
