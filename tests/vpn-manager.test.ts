import { describe, expect, it } from 'vitest';
import {
  buildScrv1,
  extractOtp,
  parseMgmtLine,
  quoteMgmtArg,
  VpnManager,
  type VpnDeps,
  type VpnEnv,
  type VpnSocket,
} from '../packages/orchestrator/src/vpn/index.js';

describe('vpn mgmt 协议', () => {
  it('解析 openvpn 管理口推来的行', () => {
    expect(parseMgmtLine(">PASSWORD:Need 'Auth' username/password SC:1,Authenticator 6 digits")).toEqual({ type: 'need-auth', staticChallenge: true });
    expect(parseMgmtLine(">PASSWORD:Need 'Auth' username/password")).toEqual({ type: 'need-auth', staticChallenge: false });
    expect(parseMgmtLine(">PASSWORD:Verification Failed: 'Auth' ['动态验证码错误或已使用']")).toEqual({ type: 'auth-failed', reason: '动态验证码错误或已使用' });
    expect(parseMgmtLine('>STATE:1793842502,CONNECTED,SUCCESS,10.8.0.109,120.46.210.36,1194,,')).toEqual({ type: 'state', state: 'CONNECTED', detail: 'SUCCESS', localIp: '10.8.0.109' });
    expect(parseMgmtLine('>FATAL:cannot open tun')).toEqual({ type: 'fatal', message: 'cannot open tun' });
  });

  it('参数转义；换行一律拒绝（防往管理口多塞一条命令）', () => {
    expect(quoteMgmtArg('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => quoteMgmtArg('x\nsignal SIGTERM')).toThrow();
    expect(() => quoteMgmtArg('x\r')).toThrow();
  });

  it('SCRV1 = base64(密码):base64(令牌)', () => {
    expect(buildScrv1('pw', '123456')).toBe(`SCRV1:${Buffer.from('pw').toString('base64')}:${Buffer.from('123456').toString('base64')}`);
  });

  it('只认恰好一段 6 位数字', () => {
    expect(extractOtp('934184')).toBe('934184');
    expect(extractOtp('令牌 934184 谢谢')).toBe('934184');
    expect(extractOtp('934 184')).toBe('934184');
    expect(extractOtp('12345')).toBeNull();
    expect(extractOtp('1234567')).toBeNull();
    expect(extractOtp('111111 222222')).toBeNull();
    expect(extractOtp('')).toBeNull();
  });
});

class FakeSock implements VpnSocket {
  written: string[] = [];
  private lineCbs: ((l: string) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  closed = false;
  write(l: string) { this.written.push(l); }
  onLine(cb: (l: string) => void) { this.lineCbs.push(cb); }
  onClose(cb: () => void) { this.closeCbs.push(cb); }
  close() { if (!this.closed) { this.closed = true; this.closeCbs.forEach((c) => c()); } }
  push(line: string) { this.lineCbs.forEach((c) => c(line)); }
  serverClose() { this.closed = true; this.closeCbs.forEach((c) => c()); }
}

function setup(opts: { otp?: string | null; running?: VpnEnv[] } = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  const running = new Set<VpnEnv>(opts.running ?? []);
  let sock: FakeSock | null = null;
  const deps: VpnDeps = {
    helper: async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return { code: 0, stdout: ['prod', 'dev'].map((e) => `${e} ${running.has(e as VpnEnv) ? 'running' : 'stopped'}`).join('\n'), stderr: '' };
      if (args[0] === 'up') { running.add(args[1]); return { code: 0, stdout: `/run/${args[1]}.sock\n`, stderr: '' }; }
      const was = running.delete(args[1]);
      return { code: 0, stdout: `${args[1]} ${was ? 'stopped' : 'not-running'}`, stderr: '' };
    },
    connect: async () => (sock = new FakeSock()),
    readCredentials: async () => ({ username: 'u', password: 'p"w' }),
    askOtp: async () => (opts.otp === undefined ? '123456' : opts.otp),
    notify: async (_c, t) => { notes.push(t); },
    connectTimeoutMs: 50,
  };
  const mgr = new VpnManager(deps);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { mgr, calls, notes, sockRef: () => sock!, tick, running };
}

describe('VpnManager', () => {
  it('完整连接：hold release → 要凭证 → SCRV1 提交 → CONNECTED', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'chat1');
    await t.tick(); await t.tick();
    const s = t.sockRef();
    expect(s.written).toEqual(['state on', 'hold release']);
    s.push(">PASSWORD:Need 'Auth' username/password SC:1,Authenticator 6 digits");
    await t.tick(); await t.tick();
    expect(s.written[2]).toBe('username "Auth" "u"');
    expect(s.written[3]).toBe(`password "Auth" "${buildScrv1('p"w', '123456')}"`);
    s.push('>STATE:1,CONNECTED,SUCCESS,10.8.0.109,1.2.3.4,1194,,');
    const r = await p;
    expect(r).toMatchObject({ ok: true, localIp: '10.8.0.109' });
    expect((await t.mgr.status()).find((x) => x.env === 'dev')).toMatchObject({ running: true, phase: 'connected', localIp: '10.8.0.109' });
  });

  it('认证失败 → down 掉并带上服务器给的原因', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Verification Failed: 'Auth' ['动态验证码错误或已使用']");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('动态验证码错误或已使用');
    expect(t.calls).toContain('down dev');
    expect(t.running.has('dev')).toBe(false);
  });

  it('没拿到令牌 → down，不提交任何凭证', async () => {
    const t = setup({ otp: null });
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(t.sockRef().written.some((l) => l.startsWith('password'))).toBe(false);
    expect(t.calls).toContain('down dev');
  });

  it('交完令牌迟迟没连上 → 超时 down', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('超时');
    expect(t.calls).toContain('down dev');
  });

  it('连上之后 openvpn 退出 → 通知发起的 chat 掉线了', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await t.tick(); await t.tick();
    t.sockRef().push('>STATE:1,CONNECTED,SUCCESS,10.8.0.1,,,,');
    await p;
    t.sockRef().serverClose();
    await t.tick(); await t.tick();
    expect(t.notes.some((n) => n.includes('断开了'))).toBe(true);
    expect((await t.mgr.status()).find((x) => x.env === 'dev')?.running).toBe(false);
  });

  it('连上后掉线重连、重新认证失败 → 通知 chat（不是静默）', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await t.tick(); await t.tick();
    t.sockRef().push('>STATE:1,CONNECTED,SUCCESS,10.8.0.1,,,,');
    await p;
    t.sockRef().push('>STATE:2,RECONNECTING,ping-restart,,,,,');
    await t.tick();
    t.sockRef().push(">PASSWORD:Verification Failed: 'Auth' ['会话已到期']");
    await t.tick(); await t.tick();
    expect(t.notes.some((n) => n.includes('掉线'))).toBe(true);
    expect(t.notes.some((n) => n.includes('会话已到期'))).toBe(true);
    expect(t.calls).toContain('down dev');
  });

  it('掉线软重启后再次 HOLD → 自动 hold release（不卡在重连）', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await t.tick(); await t.tick();
    t.sockRef().push('>STATE:1,CONNECTED,SUCCESS,10.8.0.1,,,,');
    await p;
    const before = t.sockRef().written.length;
    t.sockRef().push('>STATE:2,RECONNECTING,ping-restart,,,,,');
    await t.tick();
    t.sockRef().push('>HOLD:Waiting for hold release:1');
    await t.tick();
    expect(t.sockRef().written.slice(before)).toEqual(['hold release']);
  });

  it('主动 /vpn off 之后迟到的 HOLD → 不再放行', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await t.tick(); await t.tick();
    t.sockRef().push('>STATE:1,CONNECTED,SUCCESS,10.8.0.1,,,,');
    await p;
    await t.mgr.disconnect('dev');
    const before = t.sockRef().written.length;
    t.sockRef().push('>HOLD:Waiting for hold release:1');
    await t.tick();
    expect(t.sockRef().written.length).toBe(before);
  });

  async function connected(t: ReturnType<typeof setup>) {
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await t.tick(); await t.tick();
    t.sockRef().push('>STATE:1,CONNECTED,SUCCESS,10.8.0.1,,,,');
    expect((await p).ok).toBe(true);
  }

  it('连上之后 openvpn FATAL → 通知 chat 并 down', async () => {
    const t = setup();
    await connected(t);
    t.sockRef().push('>FATAL:tun device gone');
    await t.tick(); await t.tick();
    expect(t.notes.some((n) => n.includes('tun device gone'))).toBe(true);
    expect(t.calls.filter((c) => c === 'down dev').length).toBeGreaterThan(0);
  });

  it('重新认证交完令牌一直不 CONNECTED → 也有超时兜底并通知', async () => {
    const t = setup();
    await connected(t);
    t.sockRef().push('>STATE:2,RECONNECTING,ping-restart,,,,,');
    await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await new Promise((r) => setTimeout(r, 120));
    expect(t.notes.some((n) => n.includes('超时'))).toBe(true);
    expect((await t.mgr.status()).find((x) => x.env === 'dev')?.running).toBe(false);
  });

  it('首次 CONNECTED 会清掉超时定时器（连上后不会被误判超时断开）', async () => {
    const t = setup();
    await connected(t);
    await new Promise((r) => setTimeout(r, 120));
    expect((await t.mgr.status()).find((x) => x.env === 'dev')).toMatchObject({ running: true, phase: 'connected' });
    expect(t.notes).toEqual([]);
  });

  it('手动 /vpn off 不发「掉线」通知', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
    await t.tick(); await t.tick();
    t.sockRef().push('>STATE:1,CONNECTED,SUCCESS,10.8.0.1,,,,');
    await p;
    const r = await t.mgr.disconnect('dev');
    await t.tick();
    expect(r).toMatchObject({ ok: true, message: '已断开测试环境' });
    expect(t.notes).toEqual([]);
  });

  it('非 static-challenge 配置 → 拒绝（不猜令牌怎么拼）', async () => {
    const t = setup();
    const p = t.mgr.connect('dev', 'c');
    await t.tick(); await t.tick();
    t.sockRef().push(">PASSWORD:Need 'Auth' username/password");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(t.sockRef().written.some((l) => l.startsWith('password'))).toBe(false);
  });

  it('同一环境连续失败 3 次 → 冷却，不再 up', async () => {
    const t = setup({ otp: null });
    for (let i = 0; i < 3; i++) {
      const p = t.mgr.connect('dev', 'c');
      await t.tick(); await t.tick();
      t.sockRef().push(">PASSWORD:Need 'Auth' username/password SC:1,x");
      expect((await p).ok).toBe(false);
    }
    const ups = t.calls.filter((c) => c === 'up dev').length;
    const r = await t.mgr.connect('dev', 'c');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('冷却');
    expect(t.calls.filter((c) => c === 'up dev').length).toBe(ups);
  });

  it('已在运行（daemon 重启前连的）→ 不重复 up', async () => {
    const t = setup({ running: ['dev'] });
    const r = await t.mgr.connect('dev', 'c');
    expect(r.ok).toBe(false);
    expect(t.calls).not.toContain('up dev');
  });
});

describe('敏感问答（VPN 令牌）不回显', () => {
  it('AskManager 标记 sensitive，且能查到「下一条是敏感输入」', async () => {
    const { AskManager } = await import('../packages/orchestrator/src/ask/manager.js');
    const m = new AskManager();
    const { request } = await m.create({ chatId: 'c1', type: 'input', title: 't', sensitive: true, timeoutMs: 60_000 });
    expect(request.sensitive).toBe(true);
    expect(m.isAwaitingSensitiveInput('c1')).toBe(true);
    expect(m.isAwaitingSensitiveInput('c2')).toBe(false);
    await m.cancel(request.id, 'test');
    expect(m.isAwaitingSensitiveInput('c1')).toBe(false);
  });

  it('敏感问答结束后 2 分钟内，整条只有 6 位数字的消息算「迟到的令牌」', async () => {
    const { AskManager } = await import('../packages/orchestrator/src/ask/manager.js');
    const m = new AskManager();
    expect(m.isLateSensitiveReply('c1', '123456')).toBe(false); // 没问过
    const { request } = await m.create({ chatId: 'c1', type: 'input', title: 't', sensitive: true, timeoutMs: 60_000 });
    m.answer(request.id, { kind: 'input', text: 'abc' }, 'test');
    expect(m.isLateSensitiveReply('c1', '123456')).toBe(true);
    expect(m.isLateSensitiveReply('c1', '123 456')).toBe(true);
    expect(m.isLateSensitiveReply('c1', '令牌 123456')).toBe(true);
    expect(m.isLateSensitiveReply('c1', '验证码是123456')).toBe(true);
    expect(m.isLateSensitiveReply('c1', '帮我看下 123456 这个单号')).toBe(false); // 普通消息不误拦
    expect(m.isLateSensitiveReply('c2', '123456')).toBe(false);
    expect(m.isLateSensitiveReply('c1', '123456', Date.now() + 3 * 60 * 1000)).toBe(false); // 过了窗口
    const plain = await m.create({ chatId: 'c3', type: 'input', title: 't', timeoutMs: 60_000 });
    m.answer(plain.request.id, { kind: 'input', text: 'x' }, 'test');
    expect(m.isLateSensitiveReply('c3', '123456')).toBe(false); // 非敏感问答不触发
  });

  it('askCard 渲染已回答的敏感 input：不出现原文', async () => {
    const { askCard } = await import('../packages/im-lark/src/lark/cards.js');
    const req = {
      id: 'a', chatId: 'c', type: 'input' as const, title: 't', options: [], createdAt: 0, status: 'answered' as const,
      answer: { kind: 'input' as const, text: '934184' }, selection: [], sensitive: true,
    };
    expect(JSON.stringify(askCard(req))).not.toContain('934184');
    expect(JSON.stringify(askCard({ ...req, sensitive: false }))).toContain('934184');
  }, 30_000); // cards.js 依赖重，全量并发跑时首次 import 可能超过默认 5s
});
