// 端到端 OIDC 冒烟：起一个「假 IdP」（自签 RSA + 真 JWT）+ relay，驱动完整授权码流程。
// 用法：npx tsx tests/oidc-smoke.ts
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OidcClient } from '../../multiagent-relay/src/oidc.ts';

const RELAY_DIR = process.env['RELAY_PROJECT_DIR'] ?? join(process.cwd(), '..', 'multiagent-relay');
const RELAY_PORT = 8802;
const IDP_PORT = 8803;
const IDP = `http://localhost:${IDP_PORT}`;
const RELAY = `http://localhost:${RELAY_PORT}`;
const REDIRECT = `${RELAY}/auth/callback`;
const CLIENT_ID = 'relay-client';
const CLIENT_SECRET = 'relay-secret-abcdef123456';
const TEST_EMAIL = 'dave@ihealthlabs-us.com';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failures++;
}
const b64url = (b: Buffer) => b.toString('base64url');

async function main(): Promise<void> {
  // 1) 自签 RSA 密钥 + 组 JWK（带 kid）
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' };

  // code → { nonce }（/authorize 时暂存，/token 时取）
  const codes = new Map<string, { nonce: string }>();

  // 2) 假 IdP
  const idp = createServer((req, res) => {
    const u = new URL(req.url ?? '/', IDP);
    if (u.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({
        issuer: IDP,
        authorization_endpoint: `${IDP}/authorize`,
        token_endpoint: `${IDP}/token`,
        jwks_uri: `${IDP}/jwks`,
      }));
    }
    if (u.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (u.pathname === '/authorize') {
      // 直接“同意登录” → 生成 code 绑定 nonce，302 回 relay callback（带原样 state）
      const nonce = u.searchParams.get('nonce') ?? '';
      const state = u.searchParams.get('state') ?? '';
      const redir = u.searchParams.get('redirect_uri') ?? REDIRECT;
      const code = randomBytes(9).toString('hex');
      codes.set(code, { nonce });
      res.writeHead(302, { location: `${redir}?code=${code}&state=${encodeURIComponent(state)}` });
      return void res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const code = p.get('code') ?? '';
        const rec = codes.get(code);
        // 校验 client 凭证（假 IdP 也做一下，贴近真实）
        if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET || !rec) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        const now = Math.floor(Date.now() / 1000);
        const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
        const payload = b64url(Buffer.from(JSON.stringify({
          iss: IDP, aud: CLIENT_ID, sub: 'user-dave', email: TEST_EMAIL, email_verified: true,
          nonce: rec.nonce, iat: now, exp: now + 300,
        })));
        const sig = b64url(cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'x', token_type: 'Bearer', id_token: `${header}.${payload}.${sig}` }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => idp.listen(IDP_PORT, r));

  // 3) 起 relay（指向假 IdP）
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-oidc-'));
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      RELAY_PORT: String(RELAY_PORT), RELAY_DATA_DIR: dataDir, RELAY_PUBLIC_URL: RELAY,
      OIDC_ISSUER: IDP, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET, OIDC_REDIRECT_URI: REDIRECT,
    },
    stdio: 'ignore', detached: true,
  });

  try {
    // 等 relay tsx 冷启（冷启可能 >3s）；轮询 health 直到就绪，最多 15s
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`${RELAY}/v1/health`)).ok) break; } catch { /* not up yet */ }
      await sleep(500);
    }

    check('/api/config 报 oidcEnabled', (await (await fetch(`${RELAY}/api/config`)).json()).oidcEnabled === true);

    // 4) 走流程：/auth/login → (relay 302 到 IdP authorize)
    const r1 = await fetch(`${RELAY}/auth/login`, { redirect: 'manual' });
    const idpUrl = r1.headers.get('location') ?? '';
    check('/auth/login 302 到 IdP authorize（带 state/nonce）',
      r1.status === 302 && idpUrl.startsWith(`${IDP}/authorize`) && idpUrl.includes('state=') && idpUrl.includes('nonce='));

    // IdP authorize → 302 回 relay callback（带 code/state）
    const r2 = await fetch(idpUrl, { redirect: 'manual' });
    const cbUrl = r2.headers.get('location') ?? '';
    check('IdP 302 回 relay callback（带 code）', r2.status === 302 && cbUrl.startsWith(REDIRECT) && cbUrl.includes('code='));

    // relay callback → 换 token + 验 JWT + 签发登录码 → 302 到 /#code=...（token 不进 URL）
    const r3 = await fetch(cbUrl, { redirect: 'manual' });
    const finalLoc = r3.headers.get('location') ?? '';
    check('callback 成功 302 到带一次性登录码的 fragment（token 不进 URL）',
      r3.status === 302 && finalLoc.includes('#code=') && !finalLoc.includes('token=') && !finalLoc.includes('error='));
    const loginCode = new URLSearchParams(finalLoc.split('#')[1] ?? '').get('code') ?? '';

    // 前端用登录码换真 token（走响应体）
    const ex = await (await fetch(`${RELAY}/api/login-exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: loginCode }),
    })).json() as { token: string; identity: string };
    const token = ex.token ?? '';
    const id = ex.identity ?? '';
    check('登录码换出 mrt_ token 且身份=IdP email', token.startsWith('mrt_') && id === TEST_EMAIL);

    const reuse = await fetch(`${RELAY}/api/login-exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: loginCode }),
    });
    check('登录码一次性（二次换取被拒）', reuse.status === 400);

    // 5) 该 token 能鉴权
    const roster = await (await fetch(`${RELAY}/api/roster`, { headers: { authorization: `Bearer ${token}` } })).json();
    check('OIDC 签发的 token 可鉴权 + 身份进 roster',
      roster.me === TEST_EMAIL && roster.contacts.some((c: { identity: string; self: boolean }) => c.identity === TEST_EMAIL && c.self));

    // 6) 安全：state 重放/伪造被拒（伪造 code+state 直接打 callback）
    const forged = await fetch(`${REDIRECT}?code=whatever&state=forged-state`, { redirect: 'manual' });
    const forgedLoc = forged.headers.get('location') ?? '';
    check('伪造 state 的 callback 被拒（回 #error）', forgedLoc.includes('#error='));

    // 7) 安全：state 单次消费（同一 state 不能重放）——重放上一步真实 IdP 回来的 cbUrl
    const replay = await fetch(cbUrl, { redirect: 'manual' });
    const replayLoc = replay.headers.get('location') ?? '';
    check('state 单次消费，重放被拒', replayLoc.includes('#error='));

    // 8) verifyIdToken 各失败分支（直接单测验签逻辑，注入 jwks 免网络）
    const client = new OidcClient({ issuer: IDP, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, scopes: 'openid email', emailClaim: 'email' });
    // 注入 discovery/jwks 缓存（避免真去 fetch）
    (client as unknown as { jwks: unknown }).jwks = { data: [jwk], at: Date.now() };
    (client as unknown as { discovery: unknown }).discovery = { data: { issuer: IDP, authorization_endpoint: '', token_endpoint: '', jwks_uri: '' }, at: Date.now() };
    const now = Math.floor(Date.now() / 1000);
    const mk = (claims: Record<string, unknown>, opts: { alg?: string; badSig?: boolean } = {}) => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: opts.alg ?? 'RS256', kid, typ: 'JWT' })));
      const payload = b64url(Buffer.from(JSON.stringify(claims)));
      if (opts.alg === 'none') return `${header}.${payload}.`;
      let sig = b64url(cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey));
      if (opts.badSig) sig = sig.slice(0, -4) + (sig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
      return `${header}.${payload}.${sig}`;
    };
    const base = { iss: IDP, aud: CLIENT_ID, email: TEST_EMAIL, email_verified: true, nonce: 'N', iat: now, exp: now + 300 };
    const rejects = async (name: string, token: string, nonce = 'N') => {
      let threw = false;
      try { await client.verifyIdToken(token, nonce); } catch { threw = true; }
      check('verifyIdToken 拒绝：' + name, threw);
    };
    // 正例先过
    const good = await client.verifyIdToken(mk(base), 'N').then((r) => r.email === TEST_EMAIL).catch(() => false);
    check('verifyIdToken 正例通过', good);
    await rejects('alg=none', mk(base, { alg: 'none' }));
    await rejects('签名被篡改', mk(base, { badSig: true }));
    await rejects('iss 不匹配', mk({ ...base, iss: 'https://evil' }));
    await rejects('aud 不匹配', mk({ ...base, aud: 'other-client' }));
    await rejects('已过期', mk({ ...base, exp: now - 10 }));
    await rejects('缺 exp', mk({ iss: IDP, aud: CLIENT_ID, email: TEST_EMAIL, email_verified: true, nonce: 'N', iat: now }));
    await rejects('nonce 不匹配', mk({ ...base, nonce: 'WRONG' }));
    await rejects('email_verified=false', mk({ ...base, email_verified: false }));
    await rejects('缺 email', mk({ iss: IDP, aud: CLIENT_ID, email_verified: true, nonce: 'N', iat: now, exp: now + 300 }));
    await rejects('aud 数组含 client 通过反例（错数组）', mk({ ...base, aud: ['a', 'b'] }));
  } finally {
    try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    idp.close();
  }

  console.log(failures === 0 ? '\n🎉 OIDC 全部通过' : `\n💥 ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
