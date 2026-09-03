// 端到端集成冒烟（非 vitest；tsx 直接跑）：relay + RelayClient + poller + applyIncoming。
// 用法：npx tsx tests/handoff-smoke.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, startRelayPoller } from '../packages/framework/src/relay/index.js';
import type { RelayClientConfig } from '../packages/framework/src/relay/config.js';
import { buildCreateEnvelope, buildStatusEnvelope, buildReplyEnvelope } from '../packages/orchestrator/src/handoff/envelope.js';
import type { ApplyResult, HandoffEnvelope } from '../packages/orchestrator/src/handoff/types.js';

// relay 项目目录（默认与本仓库平级的 ../multiagent-relay，可用 RELAY_PROJECT_DIR 覆盖）
const RELAY_DIR = process.env['RELAY_PROJECT_DIR'] ?? join(process.cwd(), '..', 'multiagent-relay');
const PORT = 8799;
const ATOK = 'a'.repeat(24);
const BTOK = 'b'.repeat(24);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failures++;
}

function cfg(identity: string, token: string, allow: string[]): RelayClientConfig {
  return {
    url: `http://localhost:${PORT}`,
    token,
    identity,
    allow: new Set(allow),
    aliases: new Map(),
  };
}

async function main(): Promise<void> {
  const tokensPath = join(tmpdir(), 'relay-int.tokens.json');
  writeFileSync(tokensPath, JSON.stringify({ 'alice@x.com': ATOK, 'bob@x.com': BTOK }));
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-int-'));

  const ADMIN = 'admintoken_abcdef123456';
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      RELAY_PORT: String(PORT),
      RELAY_DATA_DIR: dataDir,
      RELAY_TOKENS_FILE: tokensPath,
      RELAY_ADMIN_TOKEN: ADMIN,
      RELAY_PUBLIC_URL: `http://localhost:${PORT}`,
    },
    stdio: 'ignore',
    detached: true, // 起独立进程组，finally 里好整组 kill（否则杀 npx 会漏掉 tsx 子进程占端口）
  });
  try {
    // 等 relay tsx 冷启就绪（冷启可能 >3s），轮询 health 最多 15s
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/v1/health`)).ok) break; } catch { /* not up yet */ }
      await sleep(500);
    }
    const alice = new RelayClient(cfg('alice@x.com', ATOK, []));
    const bob = new RelayClient(cfg('bob@x.com', BTOK, ['alice@x.com']));

    // 1) 防冒充：alice 发但 from 伪造成 HACKER → relay 应盖章回 alice
    const env = buildCreateEnvelope({ to: 'bob@x.com', from: 'HACKER', title: '报错求助', summaryMd: '## 问题\nnpm install 挂了' });
    await alice.send(env);
    const peeked = await bob.poll(0);
    check('relay 投递到 bob', peeked.length === 1);
    check('防冒充：from 被盖章为 alice', peeked[0]?.from === 'alice@x.com');

    // 2) 用 HANDOFF_DATA_DIR 把 store 落盘隔离到临时目录（store 惰性读该 env）
    process.env['HANDOFF_DATA_DIR'] = join(dataDir, 'handoff-data');
    const results: Array<{ result: ApplyResult; env: HandoffEnvelope }> = [];
    const poller = startRelayPoller(bob, (result, e) => { results.push({ result, env: e }); });
    await sleep(1500);
    check('poller 收到 1 条并处理', results.length === 1);
    check('applyIncoming 建了 assignee 任务', results[0]?.result.kind === 'created' && results[0]?.result.task?.role === 'assignee');
    const taskId = results[0]?.result.task?.id ?? '';

    // 3) ack 后队列应空（重新 poll 不再拿到）
    const after = await bob.poll(0);
    check('ack 后队列清空', after.length === 0);

    // 4) 白名单闸门：carol 不在 bob.allow（这里用 alice token 但伪装 to 已被 relay 校验）——
    //    改测「不在 allow 的发件人被丢弃」：临时把 bob.allow 清空再发一条
    // 收件闸门新语义：allow 非空 = 严格 opt-in（不在名单内的丢弃）
    const bobStrict = new RelayClient(cfg('bob@x.com', BTOK, ['nobody@x.com'])); // 名单不含 alice
    const env2 = buildCreateEnvelope({ to: 'bob@x.com', from: 'alice@x.com', title: '第二条' });
    await alice.send(env2);
    const results2: Array<ApplyResult> = [];
    const poller2 = startRelayPoller(bobStrict, (r) => { results2.push(r); });
    await sleep(1500);
    check('opt-in 白名单：不在名单的发件人不投递', results2.length === 0);
    const drained = await bobStrict.poll(0);
    check('被拦截的消息也被 ack 清出队列（不卡队列）', drained.length === 0);
    poller2.stop();

    // 4b) relay 侧黑名单：bob 拉黑 alice → alice.send 被 relay 静默丢弃（blocked）
    await fetch(`http://localhost:${PORT}/api/block`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BTOK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: 'alice@x.com' }),
    });
    const r3 = await alice.send(buildCreateEnvelope({ to: 'bob@x.com', from: 'alice@x.com', title: '拉黑后' }));
    check('relay 黑名单：被拉黑发件人 send 返回 blocked', (r3 as { blocked?: boolean }).blocked === true);
    const afterBlock = await bob.poll(0);
    check('被拉黑的消息未入队', afterBlock.length === 0);
    // 解除拉黑
    await fetch(`http://localhost:${PORT}/api/unblock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BTOK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: 'alice@x.com' }),
    });

    poller.stop();

    // 5) 状态信封往返 + contacts
    const senv = buildStatusEnvelope({ id: taskId, to: 'alice@x.com', from: 'bob@x.com', status: 'accepted' });
    await bob.send(senv);
    const aItems = await alice.poll(0);
    check('状态信封 bob→alice 送达', aItems.some((x) => x.kind === 'status' && x.status === 'accepted'));
    const contacts = await alice.contacts();
    check('contacts 含两人', contacts.length === 2 && contacts.some((c) => c.identity === 'bob@x.com'));

    // 6) 门户自助接入闭环：admin 建邀请码 → redeem 签发 token → /api/enroll → 拉装机脚本
    const base = `http://localhost:${PORT}`;
    const inv = await (await fetch(`${base}/admin/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: 'carol@x.com' }),
    })).json() as { code: string };
    check('admin 建邀请码', typeof inv.code === 'string' && inv.code.length > 0);

    const badAdmin = await fetch(`${base}/admin/invite`, {
      method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ identity: 'x@x.com' }),
    });
    check('错误 admin token 被拒', badAdmin.status === 401);

    // 安全回归：含 shell 元字符的恶意 identity 被 IDENTITY_RE 拒（堵命令注入/XSS 根因）
    const evilId = await fetch(`${base}/admin/invite`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: '$(id)@corp.com' }),
    });
    check('恶意 identity（shell 元字符）被拒', evilId.status === 400);
    const evilId2 = await fetch(`${base}/admin/invite`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: "a')//@corp.com" }),
    });
    check('恶意 identity（引号/XSS）被拒', evilId2.status === 400);

    const red = await (await fetch(`${base}/api/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code }),
    })).json() as { token: string; identity: string };
    check('redeem 签发 mrt_ token 且身份正确', red.token?.startsWith('mrt_') && red.identity === 'carol@x.com');

    const reused = await fetch(`${base}/api/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code }),
    });
    check('邀请码不能二次兑换', reused.status === 400);

    const enr = await (await fetch(`${base}/api/enroll`, {
      method: 'POST', headers: { authorization: `Bearer ${red.token}` },
    })).json() as { code: string; installCmd: string };
    check('生成一次性装机命令', enr.installCmd.includes('/enroll/') && enr.installCmd.startsWith('curl'));

    const scriptRes = await fetch(`${base}/enroll/${enr.code}`);
    const script = await scriptRes.text();
    const mTok = /RELAY_TOKEN=(mrt_[a-f0-9]+)/.exec(script)?.[1];
    check('装机脚本含凭证（独立机器 token 进 .env、身份正确）',
      !!mTok && mTok !== red.token && script.includes('RELAY_IDENTITY=carol@x.com') && script.includes('.env'));

    const scriptAgain = await fetch(`${base}/enroll/${enr.code}`);
    check('装机码一次性（二次拉取 404）', scriptAgain.status === 404);

    // 新签发的机器 token 也能鉴权（动态账号库生效）
    const carol = new RelayClient(cfg('carol@x.com', mTok!, []));
    const carolContacts = await carol.contacts();
    check('自助签发的机器 token 可鉴权 + 身份进 contacts', carolContacts.some((c) => c.identity === 'carol@x.com' && c.self));

    // 7) logout：撤浏览器 token；机器 token 不受影响
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${red.token}` } });
    const afterLogout = await fetch(`${base}/api/roster`, { headers: { authorization: `Bearer ${red.token}` } });
    check('logout 后浏览器 token 失效', afterLogout.status === 401);
    const machineStill = await fetch(`${base}/api/roster`, { headers: { authorization: `Bearer ${mTok}` } });
    check('机器 token 不受浏览器 logout 影响', machineStill.status === 200);

    // ===== P3c =====
    // 8) reply 跨人对话：alice 发 reply → bob 收到 kind=reply
    await alice.send(buildReplyEnvelope({ id: taskId, to: 'bob@x.com', from: 'alice@x.com', replyText: '补充：日志在 /tmp/x.log' }));
    const bobReplies = await bob.poll(0);
    check('reply 送达（kind=reply + replyText）', bobReplies.some((x) => x.kind === 'reply' && x.replyText?.includes('日志')));
    await bob.ack(bobReplies.map((x) => x.msgId));

    // 9) 附件下载：alice 传 blob → bob 下载，内容一致
    const att = await alice.uploadBytes('trace.log', Buffer.from('ERROR at line 42'));
    const dlDir = join(dataDir, 'dl');
    const p = await bob.downloadBlob(att, dlDir);
    const dl = readFileSync(p, 'utf8');
    check('附件下载内容一致', dl === 'ERROR at line 42');

    // 10) token 管理（用 carol 的机器 token = 动态库里的）
    const cnt0 = await (await fetch(`${base}/api/tokens`, { headers: { authorization: `Bearer ${mTok}` } })).json() as { count: number };
    check('token 计数可查', typeof cnt0.count === 'number' && cnt0.count >= 1);
    const rot = await (await fetch(`${base}/api/rotate`, { method: 'POST', headers: { authorization: `Bearer ${mTok}` } })).json() as { token: string };
    check('rotate 返回新 mrt_ token', rot.token?.startsWith('mrt_') && rot.token !== mTok);
    const oldDead = await fetch(`${base}/api/roster`, { headers: { authorization: `Bearer ${mTok}` } });
    check('rotate 后旧 token 失效', oldDead.status === 401);
    const newAlive = await fetch(`${base}/api/roster`, { headers: { authorization: `Bearer ${rot.token}` } });
    check('rotate 后新 token 有效', newAlive.status === 200);

    // 10b) revoke-others：carol 再 enroll 出第二个机器 token，revoke-others 只留当前
    const m2 = (await (await fetch(`${base}/api/enroll`, { method: 'POST', headers: { authorization: `Bearer ${rot.token}` } })).json() as { installCmd: string }).installCmd;
    const m2Tok = /RELAY_TOKEN=(mrt_[a-f0-9]+)/.exec(await (await fetch(m2.split(' ').find((s) => s.includes('/enroll/'))!)).text())?.[1] ?? '';
    check('enroll 出第二个机器 token', m2Tok.startsWith('mrt_') && m2Tok !== rot.token);
    const revOth = await (await fetch(`${base}/api/revoke-others`, { method: 'POST', headers: { authorization: `Bearer ${rot.token}` } })).json() as { revoked: number };
    check('revoke-others 撤了其它 token', revOth.revoked >= 1);
    const m2Dead = await fetch(`${base}/api/roster`, { headers: { authorization: `Bearer ${m2Tok}` } });
    check('revoke-others 后其它 token 失效', m2Dead.status === 401);
    const keepAlive = await fetch(`${base}/api/roster`, { headers: { authorization: `Bearer ${rot.token}` } });
    check('revoke-others 保留当前 token', keepAlive.status === 200);

    // 11) 审计日志（admin）
    const auditRes = await (await fetch(`${base}/admin/audit?limit=50`, { headers: { authorization: `Bearer ${ADMIN}` } })).json() as { entries: Array<{ event: string }> };
    const events = new Set(auditRes.entries.map((e) => e.event));
    check('审计日志记录了关键事件', events.has('invite_create') && events.has('invite_redeem') && events.has('token_rotate'));
    const auditNoAuth = await fetch(`${base}/admin/audit`, { headers: { authorization: 'Bearer wrong' } });
    check('审计日志需 admin token', auditNoAuth.status === 401);
  } finally {
    try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
  }

  console.log(failures === 0 ? '\n🎉 全部通过' : `\n💥 ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
