import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// scripts/vpn-setup.sh 与 scripts/vpn/mchat-vpn 都以 root 跑；两处的 CONFIG-CHECK 段（OpenVPN 配置白名单）
// 必须逐字相同，且要挡得住已知的绕过写法（安全评审 2026-11-05：`--plugin` 曾整体绕过旧黑名单正则）。
const ROOT = resolve(__dirname, '..');
const SETUP = join(ROOT, 'scripts/vpn-setup.sh');
const HELPER = join(ROOT, 'scripts/vpn/mchat-vpn');

function block(file: string): string {
  const src = readFileSync(file, 'utf8');
  const m = /^# >>> CONFIG-CHECK[\s\S]*?^# <<< CONFIG-CHECK$/m.exec(src);
  if (!m) throw new Error(`no CONFIG-CHECK block in ${file}`);
  return m[0];
}

const dir = mkdtempSync(join(tmpdir(), 'vpn-check-'));
const blockFile = join(dir, 'block.sh');
writeFileSync(blockFile, block(HELPER));

function run(mode: 'check' | 'strip', config: string): string {
  const cfg = join(dir, `c${Math.random().toString(36).slice(2)}.ovpn`);
  writeFileSync(cfg, config);
  return execFileSync('/bin/bash', ['-c', `. "$1"; awk -v mode="$2" "$CONFIG_CHECK_AWK" "$3"`, 'x', blockFile, mode, cfg], {
    encoding: 'utf8',
  });
}
const check = (config: string) => run('check', config).split('\n').filter(Boolean).sort();

const GOOD = [
  'client',
  'dev tun',
  'proto udp',
  'remote vpn.example.com 1194',
  'auth-user-pass',
  'static-challenge "Authenticator 6 digits" 1',
  'redirect-gateway def1',
  '# comment',
  '; comment',
  '',
  '<ca>',
  '-----BEGIN CERTIFICATE-----',
  'up',
  'plugin /x.so',
  '-----END CERTIFICATE-----',
  '</ca>',
  'verb 3',
].join('\n');

describe('vpn scripts bash 3.2 兼容', () => {
  // macOS 自带 bash 3.2 在 UTF-8 locale 下会把紧跟的全角字符首字节当成变量名的一部分：
  // "$dropped（root" 被解析成变量 `dropped\xef…` → set -u 报 unbound variable。真机首次安装就是这么停下的（2026-11-05）
  it('不允许 $变量 后面紧跟非 ASCII 字符（要写成 ${变量}）', () => {
    for (const f of [SETUP, HELPER]) {
      const bad = readFileSync(f, 'utf8').split('\n').flatMap((l, i) =>
        [...l.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/g)].map((m) => `${f}:${i + 1} ${m[0]}`));
      expect(bad).toEqual([]);
    }
  });
});

describe('vpn scripts CONFIG-CHECK', () => {
  it('两个 root 脚本里的白名单段逐字相同', () => {
    expect(block(SETUP)).toBe(block(HELPER));
  });

  it('正常客户端配置通过（证书块里的正文不当指令）', () => {
    expect(check(GOOD)).toEqual([]);
  });

  it('已知危险指令 → DROP，含 -- 前缀写法', () => {
    expect(check('client\nplugin /a.so\n--plugin /b.so\n  --up /c.sh\nscript-security 2\n--config /tmp/x\nmanagement 127.0.0.1 1\n--log /tmp/l\nsetenv opt plugin /d.so\n')).toEqual([
      'DROP config',
      'DROP log',
      'DROP management',
      'DROP plugin',
      'DROP plugin',
      'DROP script-security',
      'DROP setenv',
      'DROP up',
    ]);
  });

  it('strip 去掉 DROP 行、其余原样保留，剥离后再查为空', () => {
    const stripped = run('strip', `${GOOD}\n--plugin /b.so\nup /x.sh\n`);
    expect(stripped).not.toMatch(/plugin \/b\.so|up \/x\.sh/);
    expect(stripped).toContain('static-challenge');
    expect(stripped).toContain('plugin /x.so'); // 证书块里的正文不动
    expect(check(stripped)).toEqual([]);
  });

  it('可疑写法 / 不认识的指令 → BAD（中止安装）', () => {
    const out = check([
      '"plugin" /a.so',
      "'up' /b.sh",
      'p\\lugin /c.so',
      'PLUGIN /d.so',
      'some-future-option x',
      '<connection>',
      'remote 1.2.3.4',
      '</connection>',
      'ca /etc/master.passwd',
      'cert ../../etc/x',
      'auth-user-pass /tmp/creds',
    ].join('\n'));
    expect(out.every((l) => l.startsWith('BAD '))).toBe(true);
    for (const w of ['"plugin"', "'up'", 'p\\lugin', 'PLUGIN', 'some-future-option', '<connection>', 'ca <非本目录文件>', 'cert <非本目录文件>', 'auth-user-pass <带文件参数>']) {
      expect(out).toContain(`BAD ${w}`);
    }
  });

  it('证书类指令允许同目录文件名和 [inline]', () => {
    expect(check('ca ca.crt\ncert client.crt\nkey client.key\ntls-auth ta.key 1\nca [inline]\n')).toEqual([]);
  });

  it('常见的安全指令放行；代理类 / <connection> 先不支持（中止安装，适配后再放）', () => {
    expect(check('block-outside-dns\npeer-fingerprint AB:CD\nroute-ipv6-gateway ::1\n')).toEqual([]);
    expect(check('http-proxy p 8080 /tmp/auth\nsocks-proxy p 1080\n<connection>\nremote x\n</connection>\n')).toEqual(
      ['BAD </connection>', 'BAD <connection>', 'BAD http-proxy', 'BAD socks-proxy'],
    );
  });

  it('未闭合的内联块 → BAD', () => {
    expect(check('<ca>\nxxx\n')).toEqual(['BAD <ca> 未闭合']);
  });

  it('CRLF 行尾不影响判定', () => {
    expect(check('client\r\n--plugin /a.so\r\n')).toEqual(['DROP plugin']);
  });
});

// 切换阶段的回滚：把 vpn-setup.sh 里「切换阶段」整段抠出来，用假路径 + 可注入失败的桩跑（不碰真实系统、不需要 root）。
// 回归点（code-reviewer 2026-11-05 两轮 high）：全局 visudo -c 失败 / 断开旧连接失败时，旧安装必须原样还在；
// 回滚函数在 set -e 下跑，某步失败不能连累后面的恢复。
describe('vpn-setup.sh 切换阶段回滚', () => {
  const src = readFileSync(SETUP, 'utf8');
  const m = /^# ===== 切换阶段[\s\S]*?(?=^ok "已安装：)/m.exec(src);
  if (!m) throw new Error('no switch phase');
  const rbDir = mkdtempSync(join(tmpdir(), 'vpn-rb-'));
  writeFileSync(join(rbDir, 'switch.sh'), m[0]);
  writeFileSync(join(rbDir, 'harness.sh'), `#!/bin/bash
set -euo pipefail
R="$1"; MODE="$2"; FRESH="$3"
DEST="$R/libexec/mchat-vpn.d"; HELPER="$R/libexec/mchat-vpn"; SUDOERS="$R/sudoers.d/mchat-vpn"; STAGE="$R/libexec/.staging"
mkdir -p "$R/libexec" "$R/sudoers.d" "$STAGE"
echo NEW > "$STAGE/marker"; echo NEWHELPER > "$STAGE/mchat-vpn"; echo NEWSUDO > "$STAGE/sudoers"
if [ "$FRESH" = no ]; then mkdir -p "$DEST/log"; echo OLD > "$DEST/marker"; echo oldlog > "$DEST/log/x"; echo OLDHELPER > "$HELPER"; echo OLDSUDO > "$SUDOERS"; fi
die() { echo "DIE: $*" >&2; exit 1; }
chown() { :; }
# cpfail：模拟备份复制到一半失败（留下半截文件）
cp() { if [ "$MODE" = cpfail ]; then echo PARTIAL > "\${@: -1}"; return 1; fi; command cp "$@"; }
stop_all() { if [ "$MODE" = stopfail ]; then die "stop fail"; fi; }
visudo() { [ "$MODE" != visudofail ]; }
OWNER=tester
reconnect_hint() { :; }
# 自检桩：真实小程序会在自检时建空的 log/（这里同样建，验证旧日志仍被换回）
sudo() { mkdir -p "$DEST/log"; [ "$MODE" != selfcheckfail ]; }
. "$(dirname "$0")/switch.sh"
`);
  const read = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return '-'; } };
  function scenario(mode: string, fresh: 'yes' | 'no') {
    const R = join(rbDir, `${mode}_${fresh}`);
    let rc = 0;
    try { execFileSync('/bin/bash', [join(rbDir, 'harness.sh'), R, mode, fresh], { stdio: 'pipe' }); } catch { rc = 1; }
    const leftovers = execFileSync('/bin/bash', ['-c', `cd "$1" && find . \\( -name '*.old.*' -o -name '*.bak.*' -o -name '*.new' -o -name '.staging' \\) | wc -l | tr -d ' '`, 'x', R], { encoding: 'utf8' }).trim();
    return {
      rc,
      dest: read(join(R, 'libexec/mchat-vpn.d/marker')),
      helper: read(join(R, 'libexec/mchat-vpn')),
      sudoers: read(join(R, 'sudoers.d/mchat-vpn')),
      log: read(join(R, 'libexec/mchat-vpn.d/log/x')),
      leftovers,
    };
  }
  const OLD = { dest: 'OLD', helper: 'OLDHELPER', sudoers: 'OLDSUDO', log: 'oldlog', leftovers: '0' };
  it('重装时断开旧连接失败 → 旧安装原样', () => expect(scenario('stopfail', 'no')).toEqual({ rc: 1, ...OLD }));
  it('重装时全局 visudo -c 失败 → 回滚到旧安装', () => expect(scenario('visudofail', 'no')).toEqual({ rc: 1, ...OLD }));
  it('备份复制到一半失败 → 正式文件原样（不拿半截备份覆盖）', () => expect(scenario('cpfail', 'no')).toEqual({ rc: 1, ...OLD }));
  it('重装时自检失败 → 回滚到旧安装', () => expect(scenario('selfcheckfail', 'no')).toEqual({ rc: 1, ...OLD }));
  it('首次安装 visudo -c 失败 → 不留半套', () =>
    expect(scenario('visudofail', 'yes')).toEqual({ rc: 1, dest: '-', helper: '-', sudoers: '-', log: '-', leftovers: '0' }));
  it('重装成功 → 新文件就位、旧日志保留、无残留', () =>
    expect(scenario('ok', 'no')).toEqual({ rc: 0, dest: 'NEW', helper: 'NEWHELPER', sudoers: 'NEWSUDO', log: 'oldlog', leftovers: '0' }));
  it('首次安装成功', () =>
    expect(scenario('ok', 'yes')).toEqual({ rc: 0, dest: 'NEW', helper: 'NEWHELPER', sudoers: 'NEWSUDO', log: '-', leftovers: '0' }));
});
