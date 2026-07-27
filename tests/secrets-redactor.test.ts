import { describe, it, expect } from 'vitest';
import { redact, hasSecrets, redactText } from '../packages/orchestrator/src/secrets/redactor.js';

describe('redact — 高置信度 token', () => {
  it('OpenAI / Anthropic sk-', () => {
    expect(redactText('key sk-ant-abcdefghijklmnopqrstuvwx done')).toContain('[REDACTED-ANTHROPIC]');
    expect(redactText('OPENAI sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX')).toContain('[REDACTED-OPENAI]');
  });
  it('AWS / 阿里云 / 华为云 AK —— 规则已移除，不再脱', () => {
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(redactText('LTAI5tABCDEFGH1234')).toBe('LTAI5tABCDEFGH1234');
    expect(redactText('HXWZabcd12345678')).toBe('HXWZabcd12345678');
  });
  it('GitHub token / PAT', () => {
    expect(redactText('ghp_' + 'a'.repeat(36))).toBe('[REDACTED-GH-TOKEN]');
    expect(redactText('github_pat_' + 'b'.repeat(50))).toBe('[REDACTED-GH-PAT]');
  });
  it('careyclaw oct_ / JWT', () => {
    expect(redactText('oct_' + 'x'.repeat(40))).toBe('[REDACTED-CAREYCLAW-TOKEN]');
    expect(
      redactText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJ'),
    ).toBe('[REDACTED-JWT]');
  });
});

describe('redact — 连接串密码', () => {
  it('只脱密码段，保留 scheme/user/host', () => {
    const out = redactText('mongodb://admin:S3cr3tP@ss@db.host:27017/x');
    // 密码被脱，但 mongodb://admin: 和 @ 结构保留
    expect(out).toContain('mongodb://admin:[REDACTED-DBPASS]@');
    expect(out).not.toContain('S3cr3tP');
  });
  it('postgres', () => {
    expect(redactText('postgres://u:pw123456@h/db')).toContain('[REDACTED-DBPASS]');
  });
});

describe('redact — 上下文赋值 + 占位符排除', () => {
  it('password= / api_key: 脱值', () => {
    expect(redactText('password=Hunter2Hunter2')).toBe('password=[REDACTED-VAL]');
    expect(redactText('api_key: "abcd1234efgh"')).toContain('[REDACTED-VAL]');
  });
  it('占位符不脱', () => {
    expect(redactText('password=YOUR_PASSWORD')).toBe('password=YOUR_PASSWORD');
    expect(redactText('secret=xxxxxxxx')).toBe('secret=xxxxxxxx');
    expect(redactText('token=process.env.TOKEN')).toBe('token=process.env.TOKEN');
  });
});

describe('redact — 不误伤 & 报告', () => {
  it('普通文本 / git SHA 不脱（无宽 hex 规则）', () => {
    const sha = 'commit 769408a1b2c3d4e5f60718293a4b5c6d7e8f9012';
    expect(redactText(sha)).toBe(sha);
    expect(redactText('普通中文说明，无凭证')).toBe('普通中文说明，无凭证');
  });
  it('hasSecrets 判断 + hits 统计', () => {
    expect(hasSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(false); // AK 规则已移除
    expect(hasSecrets('sk-ant-abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(hasSecrets('hello world')).toBe(false);
    const r = redact('AKIAIOSFODNN7EXAMPLE and sk-ant-abcdefghijklmnopqrstuvwx');
    expect(r.redactedCount).toBe(1); // 只剩 sk-ant 命中
  });
  it('空串安全', () => {
    expect(redact('').clean).toBe('');
    expect(redact('').redactedCount).toBe(0);
  });
});
