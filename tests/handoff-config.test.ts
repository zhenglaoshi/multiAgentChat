import { afterEach, describe, expect, it } from 'vitest';
import { loadRelayConfig, resolveIdentity } from '../packages/framework/src/relay/config.js';

const KEYS = ['RELAY_URL', 'RELAY_TOKEN', 'RELAY_IDENTITY', 'HANDOFF_ALLOW', 'HANDOFF_ALIASES'] as const;

function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('loadRelayConfig', () => {
  it('缺任一必填项 → null（功能不启用）', () => {
    setEnv({ RELAY_URL: 'https://r.example.com', RELAY_TOKEN: 't' }); // 缺 identity
    expect(loadRelayConfig()).toBeNull();
  });

  it('远程 http → 拒绝启动（强制 TLS）', () => {
    setEnv({ RELAY_URL: 'http://r.example.com', RELAY_TOKEN: 't', RELAY_IDENTITY: 'a@x.com' });
    expect(() => loadRelayConfig()).toThrow(/https/);
  });

  it('userinfo 伪装 localhost 的 http → 拒绝（hostname 实为 evil.com）', () => {
    setEnv({ RELAY_URL: 'http://localhost:x@evil.com', RELAY_TOKEN: 't', RELAY_IDENTITY: 'a@x.com' });
    expect(() => loadRelayConfig()).toThrow(/https/);
  });

  it('localhost.evil.com 的 http → 拒绝（非回环）', () => {
    setEnv({ RELAY_URL: 'http://localhost.evil.com', RELAY_TOKEN: 't', RELAY_IDENTITY: 'a@x.com' });
    expect(() => loadRelayConfig()).toThrow(/https/);
  });

  it('本地回环 http → 放行（调试）', () => {
    setEnv({ RELAY_URL: 'http://127.0.0.1:8787', RELAY_TOKEN: 't', RELAY_IDENTITY: 'a@x.com' });
    expect(loadRelayConfig()?.url).toBe('http://127.0.0.1:8787');
  });

  it('https 远程 → 放行，尾斜杠被清', () => {
    setEnv({ RELAY_URL: 'https://r.example.com/', RELAY_TOKEN: 't', RELAY_IDENTITY: 'a@x.com' });
    expect(loadRelayConfig()?.url).toBe('https://r.example.com');
  });

  it('解析 HANDOFF_ALLOW / HANDOFF_ALIASES', () => {
    setEnv({
      RELAY_URL: 'https://r.example.com',
      RELAY_TOKEN: 't',
      RELAY_IDENTITY: 'a@x.com',
      HANDOFF_ALLOW: 'bob@x.com, carol@x.com',
      HANDOFF_ALIASES: 'bob=bob@x.com,@carol=carol@x.com',
    });
    const cfg = loadRelayConfig()!;
    expect(cfg.allow.has('bob@x.com')).toBe(true);
    expect(cfg.allow.has('carol@x.com')).toBe(true);
    expect(resolveIdentity(cfg, '@bob')).toBe('bob@x.com');
    expect(resolveIdentity(cfg, 'carol')).toBe('carol@x.com');
    // 未知别名按原样（可能本就是邮箱）
    expect(resolveIdentity(cfg, 'dave@x.com')).toBe('dave@x.com');
  });

  it('HANDOFF_ALLOW 空 → allow 为空集（fail-closed，谁都不收）', () => {
    setEnv({ RELAY_URL: 'https://r.example.com', RELAY_TOKEN: 't', RELAY_IDENTITY: 'a@x.com' });
    expect(loadRelayConfig()!.allow.size).toBe(0);
  });
});
