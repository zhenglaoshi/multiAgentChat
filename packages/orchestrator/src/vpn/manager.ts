/**
 * VPN 连接编排：root 小程序 `mchat-vpn up <env>` 起 openvpn（挂起等管理口）→ 管理口 hold release →
 * 服务器要账号密码时，账号密码取钥匙串（Tunnelblick 保存的那份）、6 位令牌问用户 → SCRV1 提交 → 等 CONNECTED。
 * 连上后继续盯着管理口：掉线 / 会话过期 / 服务器要重新认证都通知发起的 chat。
 *
 * 宿主相关的一切（sudo 小程序、unix socket、钥匙串、飞书问答、发消息）经 VpnDeps 注入 —— 本文件纯编排，可单测。
 * 凭证只在内存里过一遍，不进日志、不进任何返回值 / 通知文案。
 */

import { logger } from '../logger.js';
import { buildScrv1, parseMgmtLine, quoteMgmtArg, VPN_ENV_LABEL, VPN_ENVS, type VpnEnv } from './mgmt.js';

export interface VpnSocket {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface VpnDeps {
  /** 免密 sudo 跑 root 小程序（只这 5 种调用） */
  helper(args: ['up', VpnEnv] | ['down', VpnEnv] | ['status']): Promise<{ code: number; stdout: string; stderr: string }>;
  connect(socketPath: string): Promise<VpnSocket>;
  readCredentials(env: VpnEnv): Promise<{ username: string; password: string }>;
  /** 问用户要 6 位令牌；超时 / 取消 / 格式不对 → null */
  askOtp(chatId: string, env: VpnEnv, reason: 'connect' | 'reauth'): Promise<string | null>;
  notify(chatId: string, text: string): Promise<void>;
  /** 交完凭证后等 CONNECTED 的上限（默认 90s） */
  connectTimeoutMs?: number;
  now?: () => number;
}

/** 失败冷却：同一环境窗口内失败这么多次就先锁一会儿（防被人反复触发、把账号试到锁定 / 反复推令牌卡骚扰） */
const FAIL_LIMIT = 3;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;

type Phase = 'starting' | 'auth' | 'connected';

interface Session {
  env: VpnEnv;
  chatId: string;
  phase: Phase;
  sock?: VpnSocket;
  localIp?: string;
  since: number;
  /** 本侧主动 down：关 socket 时别再发「掉线了」 */
  closingOnPurpose: boolean;
  authInFlight: boolean;
  /** 连上过一次：之后再要凭证就是「重新认证」 */
  everConnected?: boolean;
  settle?: (r: VpnResult) => void;
  timer?: NodeJS.Timeout;
}

export interface VpnResult {
  ok: boolean;
  message: string;
  localIp?: string;
}

export interface VpnStatusItem {
  env: VpnEnv;
  running: boolean;
  phase?: Phase;
  localIp?: string;
  since?: number;
  chatId?: string;
}

export class VpnManager {
  private sessions = new Map<VpnEnv, Session>();
  /** 令牌提问串行：飞书 input 问答每个 chat 同时只能等一个答案，两个环境同时要令牌会互相顶掉 */
  private otpChain: Promise<unknown> = Promise.resolve();
  private failures = new Map<VpnEnv, number[]>();

  constructor(private readonly deps: VpnDeps) {}

  async status(): Promise<VpnStatusItem[]> {
    const r = await this.deps.helper(['status']);
    const running = new Set<string>();
    for (const line of r.stdout.split('\n')) {
      const m = /^(prod|dev) running$/.exec(line.trim());
      if (m) running.add(m[1]!);
    }
    return VPN_ENVS.map((env) => {
      const s = this.sessions.get(env);
      const item: VpnStatusItem = { env, running: running.has(env) };
      if (s) {
        item.phase = s.phase;
        item.since = s.since;
        item.chatId = s.chatId;
        if (s.localIp) item.localIp = s.localIp;
      }
      return item;
    });
  }

  /** 连接。整个流程（含等用户回令牌）结束才 resolve。 */
  async connect(env: VpnEnv, chatId: string): Promise<VpnResult> {
    const label = VPN_ENV_LABEL[env];
    const existing = this.sessions.get(env);
    if (existing) {
      return existing.phase === 'connected'
        ? { ok: true, message: `${label}已经连着（${existing.localIp ?? '?'}）`, ...(existing.localIp ? { localIp: existing.localIp } : {}) }
        : { ok: false, message: `${label}正在连接中，等这一次结束` };
    }
    const now = (this.deps.now ?? Date.now)();
    const recent = (this.failures.get(env) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    this.failures.set(env, recent);
    if (recent.length >= FAIL_LIMIT) {
      const wait = Math.ceil((recent[recent.length - 1]! + COOLDOWN_MS - now) / 60_000);
      if (wait > 0) return { ok: false, message: `${label}最近失败了 ${recent.length} 次，先冷却 ${wait} 分钟再试（防止账号被试到锁定）` };
    }
    const st = await this.status();
    if (st.find((x) => x.env === env)?.running) {
      return { ok: false, message: `${label}的 openvpn 已在运行（可能是 daemon 重启前连的）—— 先 /vpn off ${env} 再连` };
    }

    const s: Session = { env, chatId, phase: 'starting', since: Date.now(), closingOnPurpose: false, authInFlight: false };
    this.sessions.set(env, s);

    const up = await this.deps.helper(['up', env]);
    if (up.code !== 0) {
      this.sessions.delete(env);
      return { ok: false, message: `起 openvpn 失败：${(up.stderr || up.stdout).trim().slice(0, 300)}` };
    }
    const sockPath = up.stdout.trim().split('\n').pop() ?? '';
    let sock: VpnSocket;
    try {
      sock = await this.deps.connect(sockPath);
    } catch (e) {
      await this.teardown(s);
      return { ok: false, message: `连不上管理口：${(e as Error).message}` };
    }
    s.sock = sock;

    return new Promise<VpnResult>((resolve) => {
      s.settle = (r) => {
        if (s.timer) clearTimeout(s.timer);
        s.settle = undefined;
        resolve(r);
      };
      sock.onLine((line) => void this.onLine(s, line));
      sock.onClose(() => void this.onClose(s));
      sock.write('state on');
      sock.write('hold release');
    });
  }

  async disconnect(env: VpnEnv): Promise<VpnResult> {
    const label = VPN_ENV_LABEL[env];
    const s = this.sessions.get(env);
    if (s) {
      s.closingOnPurpose = true;
      s.settle?.({ ok: false, message: `${label}连接被手动取消` });
    }
    const r = await this.deps.helper(['down', env]);
    if (s) this.dropSession(s);
    if (r.code !== 0) return { ok: false, message: `断开${label}失败：${(r.stderr || r.stdout).trim().slice(0, 300)}` };
    return { ok: true, message: r.stdout.includes(`${env} stopped`) ? `已断开${label}` : `${label}本来就没连` };
  }

  private async onLine(s: Session, line: string): Promise<void> {
    const ev = parseMgmtLine(line);
    const label = VPN_ENV_LABEL[s.env];
    switch (ev.type) {
      case 'need-auth':
        await this.supplyAuth(s, ev.staticChallenge);
        return;
      case 'auth-failed': {
        // 首次连接 / 连上后重新认证都走 fail()：它自己判断是回给 connect() 的调用方还是直接通知 chat
        // （别靠 phase 猜：掉线 RECONNECTING 时 phase 已改成 auth）
        const why = ev.reason ? `：${ev.reason}` : '';
        await this.fail(s, `认证失败${why}（令牌错了 / 过期了？换一个新令牌再发 /vpn ${s.env}）`);
        return;
      }
      case 'fatal':
        await this.fail(s, `openvpn 报错：${ev.message.slice(0, 200)}`);
        return;
      case 'hold':
        // --management-hold 不止管首次启动：掉线软重启（ping-restart / SIGUSR1）后也会再停下来等放行。
        // 不放行就永远卡在 RECONNECTING，而 tun 接口 / 路由 / /etc/resolver 还留着 → 公司域名解析全挂
        // （2026-11-06 实测卡了 37 小时）。重复放行无害。
        if (!s.closingOnPurpose) s.sock?.write('hold release');
        return;
      case 'state':
        if (ev.state === 'CONNECTED') {
          const first = s.phase !== 'connected';
          s.phase = 'connected';
          if (s.timer) {
            clearTimeout(s.timer);
            s.timer = undefined;
          }
          if (ev.localIp) s.localIp = ev.localIp;
          if (first) this.failures.delete(s.env);
          s.everConnected = true;
          if (first && s.settle) {
            s.settle({ ok: true, message: `✅ ${label}已连接（${s.localIp ?? '?'}）`, ...(s.localIp ? { localIp: s.localIp } : {}) });
          }
        } else if (s.phase === 'connected' && (ev.state === 'RECONNECTING' || ev.state === 'EXITING')) {
          logger.info('vpn state change', { env: s.env, state: ev.state, detail: ev.detail });
          if (ev.state === 'RECONNECTING') {
            s.phase = 'auth';
            delete s.localIp;
            await this.deps.notify(s.chatId, `⚠️ ${label}掉线，正在重连（${ev.detail || '原因未知'}）`).catch(() => {});
          }
        }
        return;
      default:
        return;
    }
  }

  private async supplyAuth(s: Session, staticChallenge: boolean): Promise<void> {
    if (s.authInFlight || !s.sock) return;
    const label = VPN_ENV_LABEL[s.env];
    if (!staticChallenge) {
      await this.fail(s, `${label}的配置不是 static-challenge 令牌模式，/vpn 暂不支持`);
      return;
    }
    s.authInFlight = true;
    const reauth = s.phase === 'connected' || s.everConnected === true;
    s.phase = 'auth';
    try {
      const { username, password } = await this.deps.readCredentials(s.env);
      if (this.sessions.get(s.env) !== s) return; // 读钥匙串期间（可能卡在授权框）被 /vpn off 了：别再弹令牌卡
      if (reauth) await this.deps.notify(s.chatId, `🔐 ${label}要求重新认证，请回复新的 6 位令牌`).catch(() => {});
      if (this.otpPending > 0) await this.deps.notify(s.chatId, `⏳ 另一个环境正在等令牌，${label}的令牌卡排在它后面`).catch(() => {});
      const otp = await this.serialOtp(() => this.deps.askOtp(s.chatId, s.env, reauth ? 'reauth' : 'connect'));
      if (!this.sessions.has(s.env) || this.sessions.get(s.env) !== s) return; // 等令牌期间被 /vpn off 了
      if (!otp) {
        await this.fail(s, '没收到 6 位令牌（超时 / 取消 / 格式不对）');
        return;
      }
      s.sock.write(`username "Auth" ${quoteMgmtArg(username)}`);
      s.sock.write(`password "Auth" ${quoteMgmtArg(buildScrv1(password, otp))}`);
      logger.info('vpn credentials submitted', { env: s.env, reauth });
      // 首次连接和重新认证都要有超时兜底（重新认证时 settle 早没了，不能拿它当条件）；CONNECTED 时清掉
      if (!s.timer) {
        s.timer = setTimeout(() => {
          s.timer = undefined;
          void this.fail(s, '交完令牌后迟迟没连上（超时）');
        }, this.deps.connectTimeoutMs ?? 90_000);
      }
    } catch (e) {
      await this.fail(s, `取账号密码失败：${(e as Error).message.slice(0, 200)}`);
    } finally {
      s.authInFlight = false;
    }
  }

  private otpPending = 0;

  private serialOtp(fn: () => Promise<string | null>): Promise<string | null> {
    this.otpPending++;
    const next = this.otpChain.then(fn, fn).finally(() => {
      this.otpPending--;
    });
    this.otpChain = next.catch(() => undefined);
    return next;
  }

  private async onClose(s: Session): Promise<void> {
    if (this.sessions.get(s.env) !== s) return;
    const label = VPN_ENV_LABEL[s.env];
    if (s.closingOnPurpose) return;
    if (s.settle) {
      await this.fail(s, `openvpn 退出了（日志在 /usr/local/libexec/mchat-vpn.d/log/${s.env}.log，需要 sudo 看）`);
      return;
    }
    await this.deps.notify(s.chatId, `⚠️ ${label}断开了（openvpn 已退出，可能是会话过期）—— 发 /vpn ${s.env} 重连`).catch(() => {});
    await this.teardown(s);
  }

  private async fail(s: Session, why: string): Promise<void> {
    if (this.sessions.get(s.env) !== s) return;
    const label = VPN_ENV_LABEL[s.env];
    logger.warn('vpn connect failed', { env: s.env, why });
    if (s.settle) this.failures.set(s.env, [...(this.failures.get(s.env) ?? []), (this.deps.now ?? Date.now)()]);
    const settle = s.settle;
    await this.teardown(s);
    const message = `❌ ${label}没连上：${why}`;
    // 首次连接：结果由 connect() 的调用方发；连上之后掉线重连失败：没人在等返回值，直接通知发起的 chat
    if (settle) settle({ ok: false, message });
    else await this.deps.notify(s.chatId, `${message} —— 已断开，发 /vpn ${s.env} 重连`).catch(() => {});
  }

  /** 关管理口 + down 掉 openvpn + 删会话（幂等） */
  private async teardown(s: Session): Promise<void> {
    s.closingOnPurpose = true;
    this.dropSession(s);
    await this.deps.helper(['down', s.env]).catch(() => undefined);
  }

  private dropSession(s: Session): void {
    // 先标「主动关」再关 socket：同步触发 onClose 的 socket 实现下也不会被当成掉线去通知
    s.closingOnPurpose = true;
    if (s.timer) clearTimeout(s.timer);
    try {
      s.sock?.close();
    } catch {
      /* ignore */
    }
    if (this.sessions.get(s.env) === s) this.sessions.delete(s.env);
  }
}
