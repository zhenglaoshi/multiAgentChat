/**
 * /vpn 的宿主接线：把 orchestrator/vpn 的 VpnManager 接到真实依赖上。
 *  - root 小程序：`sudo -n /usr/local/libexec/mchat-vpn up|down prod|dev / status`（scripts/vpn-setup.sh 装的，
 *    sudoers 只免密放行这 5 种调用）
 *  - 账号密码：钥匙串里 Tunnelblick 保存的那份（服务名 `Tunnelblick-Auth-<Tunnelblick 配置名>`；首次要人点一次「始终允许」）
 *  - 6 位令牌：飞书 input 问答卡（只认恰好一段 6 位数字）
 *  - Tunnelblick 冲突：同一环境 Tunnelblick 已连着就不重复连（同账号两个会话会互相踢）
 *
 * 配置（.env）：VPN_PROD_TUNNELBLICK / VPN_DEV_TUNNELBLICK = Tunnelblick 菜单里看到的配置名。没配的环境 /vpn 不可用。
 */

import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { asks, extractOtp, logger, VPN_ENV_LABEL, VpnManager, type VpnEnv, type VpnSocket } from 'multiagent-orchestrator';
import { sendTextMessage } from './api.js';
import { botIdForChat, getLarkClient } from './bots.js';

export const VPN_HELPER = '/usr/local/libexec/mchat-vpn';
/** 等用户回令牌的上限：TOTP 30s 一换，等太久没意义；但手机在别处时得留够时间 */
const OTP_TIMEOUT_MS = 5 * 60 * 1000;

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) });
    });
  });
}

export function tunnelblickName(env: VpnEnv): string | null {
  const v = (process.env[env === 'prod' ? 'VPN_PROD_TUNNELBLICK' : 'VPN_DEV_TUNNELBLICK'] ?? '').trim();
  return v || null;
}

/** Tunnelblick 里这个配置现在的状态（CONNECTED / EXITING / …）；查不到 → null */
export async function tunnelblickState(name: string): Promise<string | null> {
  const r = await run(
    '/usr/bin/osascript',
    ['-e', 'on run argv', '-e', 'tell application "Tunnelblick" to get state of first configuration where name = (item 1 of argv)', '-e', 'end run', name],
    10_000,
  );
  return r.code === 0 ? r.stdout.trim() || null : null;
}

function wrapSocket(path: string): Promise<VpnSocket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    const lineCbs: ((l: string) => void)[] = [];
    const closeCbs: (() => void)[] = [];
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        for (const cb of lineCbs) cb(line);
      }
    });
    sock.on('close', () => closeCbs.forEach((cb) => cb()));
    sock.once('error', (e) => reject(e));
    sock.once('connect', () => {
      sock.removeAllListeners('error');
      sock.on('error', (e) => logger.warn('vpn mgmt socket error', { err: e.message }));
      resolve({
        write: (line) => void sock.write(`${line}\n`),
        onLine: (cb) => void lineCbs.push(cb),
        onClose: (cb) => void closeCbs.push(cb),
        close: () => sock.destroy(),
      });
    });
  });
}

async function readKeychain(service: string, account: string): Promise<string> {
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], 20_000);
  if (r.code !== 0) {
    throw new Error(
      `读钥匙串「${service} / ${account}」失败（exit ${r.code}）—— 若 Mac 上弹了授权框没人点，需要到 Mac 前点一次「始终允许」（锁屏时点不了）`,
    );
  }
  return r.stdout.replace(/\n$/, '');
}

async function notify(chatId: string, text: string): Promise<void> {
  const client = getLarkClient(botIdForChat(chatId));
  if (!client) {
    logger.warn('vpn notify: no lark client', { chatId });
    return;
  }
  await sendTextMessage(client, chatId, text);
}

let manager: VpnManager | null = null;

export function getVpnManager(): VpnManager {
  if (manager) return manager;
  manager = new VpnManager({
    helper: (args) => run('/usr/bin/sudo', ['-n', VPN_HELPER, ...args], 30_000),
    connect: wrapSocket,
    readCredentials: async (env) => {
      const name = tunnelblickName(env);
      if (!name) throw new Error(`.env 没配 ${env === 'prod' ? 'VPN_PROD_TUNNELBLICK' : 'VPN_DEV_TUNNELBLICK'}`);
      const service = `Tunnelblick-Auth-${name}`;
      return { username: await readKeychain(service, 'username'), password: await readKeychain(service, 'password') };
    },
    askOtp: async (chatId, env, reason) => {
      // 没认出令牌就原地再问（最多 3 次），别直接收尾 —— 收尾后用户重发的真令牌会被当普通消息
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { result } = await asks.create({
          chatId,
          type: 'input',
          title: `🔐 /vpn ${env}${reason === 'reauth' ? '（重新认证）' : ''}：请回复${VPN_ENV_LABEL[env]}的 6 位令牌（手机 Authenticator 上看，回最新的）${attempt > 1 ? `（第 ${attempt} 次，只发 6 位数字）` : ''}`,
          timeoutMs: OTP_TIMEOUT_MS,
          sensitive: true,
        });
        const final = await result;
        if (final.status !== 'answered' || final.answer?.kind !== 'input') return null;
        const otp = extractOtp(final.answer.text);
        if (otp) return otp;
        await notify(chatId, attempt < 3 ? '⚠️ 没从回复里认出 6 位令牌，再发一次（只发 6 位数字）' : '⚠️ 3 次都没认出 6 位令牌，这次连接取消').catch(() => {});
      }
      return null;
    },
    notify,
  });
  return manager;
}

export async function askConfirm(chatId: string, title: string, yes: string): Promise<boolean> {
  const { result } = await asks.create({ chatId, type: 'single', title, options: [yes, '取消'], timeoutMs: 2 * 60 * 1000 });
  const final = await result;
  return final.status === 'answered' && final.answer?.kind === 'single' && final.answer.index === 0;
}

export { notify as vpnNotify };
