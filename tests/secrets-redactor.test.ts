import { describe, it, expect } from 'vitest';
import { redact, hasSecrets, redactText, redactTextStrict } from '../packages/orchestrator/src/secrets/redactor.js';

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
  it('relay 接入 token mrt_', () => {
    expect(redactText('RELAY_TOKEN=mrt_' + 'a'.repeat(48))).toBe('RELAY_TOKEN=[REDACTED-RELAY-TOKEN]');
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

describe('redact — 值不再被字符集截断（security MED：尾巴明文外泄）', () => {
  it('含符号的强密码整段脱，不留后半截', () => {
    // 旧字符集 [A-Za-z0-9/+\-_.] 在第一个 ! 处断开，产出
    // `password: "[REDACTED-VAL]!Pass#2024"` —— 真密码的后半截紧跟脱敏标记明文送出
    const out = redactText('password: "Str0ng!Pass#2024"');
    expect(out).toBe('password: "[REDACTED-VAL]"');
    expect(out).not.toContain('Pass#2024');
  });

  it('不吞掉后面的正常句子（脱到断句标点为止）', () => {
    expect(redactText('密码是 abc123!Q@x，然后重启服务')).toBe('密码是 [REDACTED-VAL]，然后重启服务');
  });

  it('不对已脱敏的标记二次脱敏（会破坏标记并擦掉更精确的类型）', () => {
    expect(redactText('RELAY_TOKEN=mrt_' + 'a'.repeat(48))).toBe('RELAY_TOKEN=[REDACTED-RELAY-TOKEN]');
  });
});

describe('redact — 泛化的 env 变量名（security HIGH：白名单外的 key 整个漏过）', () => {
  it('任意前缀的 _TOKEN / _KEY 都脱', () => {
    expect(redactText('WECOM_TOKEN=abc123def456ghi789')).toBe('WECOM_TOKEN=[REDACTED-VAL]');
    expect(redactText('ENCRYPTION_KEY=s3cr3tvalue12345')).toBe('ENCRYPTION_KEY=[REDACTED-VAL]');
    expect(redactText('PRIVATE_KEY=MIIEvQIBADANBgkq')).toBe('PRIVATE_KEY=[REDACTED-VAL]');
  });

  it('裸 key 不收（JSON 里 "key": "name" 满地都是，收了全是误伤）', () => {
    expect(redactText('{"key": "name", "value": "hello"}')).toBe('{"key": "name", "value": "hello"}');
  });
});

describe('redact — 自然语言里的凭证交代（会话历史源装的是人话，没有 : / =）', () => {
  it('中文「密码是 x」/「token 为 x」', () => {
    expect(redactText('生产库密码是 abc123!Q@x')).toContain('[REDACTED-VAL]');
    expect(redactText('token 为 eyabcdefghijklmn')).toContain('[REDACTED-VAL]');
  });

  it('没跟具体值的正常句子不误伤', () => {
    expect(redactText('这个项目的密钥管理方案需要重新设计一下')).toBe('这个项目的密钥管理方案需要重新设计一下');
  });

  it('占位符不脱', () => {
    expect(redactText('password: YOUR_PASSWORD_HERE')).toBe('password: YOUR_PASSWORD_HERE');
  });
});

describe('redactTextStrict — AK 类只在 strict 下脱（默认行为不变，是用户明确要求）', () => {
  it('默认不脱 AK，strict 才脱', () => {
    const t = '帮我看下这个 AKIAIOSFODNN7EXAMPLE 为什么调不通';
    expect(redactText(t)).toBe(t);
    expect(redactTextStrict(t)).toContain('[REDACTED-AWS-AK]');
  });

  it('阿里云 LTAI / access_key 赋值', () => {
    expect(redactTextStrict('LTAI5tAbCdEfGhIjKlMnOpQr')).toContain('[REDACTED-ALIYUN-AK]');
    expect(redactTextStrict('access_key_id=LTAIabcdefgh1234')).toContain('[REDACTED');
  });

  it('strict 不影响其它规则的结果', () => {
    expect(redactTextStrict('普通文本，没有任何凭证')).toBe('普通文本，没有任何凭证');
  });
});

describe('redact — 多行值 / PEM 块（security HIGH：值字符集不含换行，密钥主体会明文漏出）', () => {
  it('PEM 私钥整块脱，主体一个字节都不留', () => {
    const pem = [
      'private_key: "-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
      'MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu',
      '-----END PRIVATE KEY-----"',
    ].join('\n');
    const out = redactText(pem);
    expect(out).toBe('private_key: "[REDACTED-PEM-BLOCK]"');
    expect(out).not.toContain('MIIEvQIB');
    expect(out).not.toContain('MzEfYyji');
  });

  it('OPENSSH / RSA 等其它 PEM 类型同样整块脱', () => {
    const k = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactText(k)).toBe('[REDACTED-PEM-BLOCK]');
  });

  it('END 缺失（被截断）时兜底吞掉紧随的 base64 行', () => {
    const out = redactText('key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdefghijklmnop');
    expect(out).not.toContain('MIIEowIBAAKCAQEAabcdefghijklmnop');
    expect(out).toContain('[REDACTED-PEM-BLOCK]');
  });

  it('加密私钥的 Proc-Type / DEK-Info 头 + 空行也整块脱（只认 base64 会漏掉主体）', () => {
    const k = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,ABCDEF0123456789',
      '',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactText(k);
    expect(out).toBe('[REDACTED-PEM-BLOCK]');
    expect(out).not.toContain('MIIEvQIB');
  });

  it('PGP 块（Version 头 + 空行）同样整块脱', () => {
    const k = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKc\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(redactText(k)).toBe('[REDACTED-PEM-BLOCK]');
  });

  it('CRLF 行尾不影响', () => {
    const k = '-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKc\r\n-----END PRIVATE KEY-----';
    expect(redactText(k)).toBe('[REDACTED-PEM-BLOCK]');
  });

  it('单行粘贴（换行被网页/聊天工具吞掉）也整块脱', () => {
    const b = 'MIIEowIBAAKCAQEAtN4exampleABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';
    expect(redactText(`-----BEGIN PRIVATE KEY-----${b}-----END PRIVATE KEY-----`)).toBe('[REDACTED-PEM-BLOCK]');
    const noEnd = redactText(`key: -----BEGIN PRIVATE KEY-----${b}`);
    expect(noEnd).not.toContain(b);
  });

  it('正文被引用前缀 "> " 污染（转发/引用回复）仍整块脱', () => {
    const b = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP';
    const out = redactText(`-----BEGIN RSA PRIVATE KEY-----\n> ${b}\n> ${b}\n-----END RSA PRIVATE KEY-----`);
    expect(out).not.toContain(b);
    expect(redactText(`-----BEGIN RSA PRIVATE KEY-----\n> ${b}\n> ${b}`)).not.toContain(b);
  });

  it('正文行尾多余空格（富文本转纯文本残留）仍整块脱', () => {
    const b = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP';
    expect(redactText(`-----BEGIN RSA PRIVATE KEY-----\n${b} \n${b}\n-----END RSA PRIVATE KEY-----`)).not.toContain(b);
    expect(redactText(`-----BEGIN RSA PRIVATE KEY-----\n${b} \n${b}`)).not.toContain(b);
  });

  it('PGP ASCII armor 的 =CRC 校验行不打断匹配', () => {
    const b = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP';
    const out = redactText(`-----BEGIN PGP MESSAGE-----\nVersion: GnuPG v2\n\n${b}\n=aBcD\n-----END PGP MESSAGE-----`);
    expect(out).not.toContain(b);
  });

  it('块结束后的正文不被吞，相邻两个块之间的说明也保留', () => {
    const b = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP';
    const out = redactText(
      `-----BEGIN PRIVATE KEY-----\n${b}\n-----END PRIVATE KEY-----\n中间说明\n-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`,
    );
    expect(out).toContain('中间说明');
    expect(out).not.toContain(b);
  });

  it('BEGIN 头行尾随空白：整块仍被脱，且绝不产生「只脱了头却回报已脱敏」的假阳性', () => {
    const b = 'MIIEpAIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    for (const tail of [' ', '\t', '  ']) {
      const r = redact(`-----BEGIN RSA PRIVATE KEY-----${tail}\n${b}\n-----END RSA PRIVATE KEY-----`);
      expect(r.clean).not.toContain(b);
      expect(r.clean).not.toContain('-----END');
    }
    // 无 END 收尾时同样不能只脱头
    const r2 = redact(`-----BEGIN RSA PRIVATE KEY----- \n${b}`);
    expect(r2.clean).not.toContain(b);
  });

  it('「头 + 零行正文」不算命中（宁可整段留明文，也不给已脱敏的假信号）', () => {
    const r = redact('-----BEGIN PRIVATE KEY-----\n\n\n后面全是正常文字');
    expect(r.clean).toContain('后面全是正常文字');
    // 没吃到任何实质正文 → 不该计一次 PEM 命中
    expect(r.hits.find((h) => h.kind === 'PEM-BLOCK')).toBeUndefined();
  });

  it('正文中提前出现一行合法 END 时，不在那里提前收口（贪婪吃到真正的结尾）', () => {
    const b1 = 'MIIEpAIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const b2 = 'MIIEpAIBAAKCAQEAyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
    const out = redactText(
      `-----BEGIN RSA PRIVATE KEY-----\n${b1}\n-----END RSA PRIVATE KEY-----\n${b2}\n-----END RSA PRIVATE KEY-----`,
    );
    expect(out).not.toContain(b1);
    expect(out).not.toContain(b2);
  });

  it('含 EC/RSA 子串的普通词不当成 PEM 标签（否则整段业务正文被静默吞掉）', () => {
    // SECTION 含 "EC"、TECHNICAL 含 "EC"：裸子串匹配会让规则1 贪婪吃到配对 END，
    // 把中间正文替换成 [REDACTED-PEM-BLOCK] —— 不是泄密，是内容损毁 + 假报「已脱敏」
    for (const doc of [
      '-----BEGIN SECTION-----\n这是文档分节标题，不是密钥\n-----END SECTION-----',
      '-----BEGIN TECHNICAL NOTES-----\n技术说明正文\n-----END TECHNICAL NOTES-----',
    ]) {
      expect(redactText(doc)).toBe(doc);
    }
    // 真正的 EC 私钥（EC 是独立的词）仍整块脱
    const ec = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab\n-----END EC PRIVATE KEY-----';
    expect(redactText(ec)).toBe('[REDACTED-PEM-BLOCK]');
  });

  it('普通文本里的 -----BEGIN X----- 不误伤（标签限定真实类型关键字）', () => {
    expect(redactText('-----BEGIN X-----\n普通内容')).toBe('-----BEGIN X-----\n普通内容');
    expect(redactText('----- 分割线 -----\n正文')).toBe('----- 分割线 -----\n正文');
  });

  it('PEM 头后面的正常文字不被吞掉', () => {
    const out = redactText('-----BEGIN PRIVATE KEY-----\n这段是我的说明文字，不该被吃掉');
    expect(out).toContain('这段是我的说明文字，不该被吃掉');
  });
});

describe('redact — 长变量名 / 全角分隔符 / 驼峰（HIGH#2 泛化后的残留绕过）', () => {
  it('前缀超长的变量名不再整条漏过', () => {
    expect(redactText('AZURE_STORAGE_ACCOUNT_ACCESS_KEY=sk-realvalue1234567890'))
      .toBe('AZURE_STORAGE_ACCOUNT_ACCESS_KEY=[REDACTED-VAL]');
    expect(redactText('SOME_REALLY_LONG_DESCRIPTIVE_SERVICE_NAME_API_KEY=sk-realvalue1234567890'))
      .toContain('[REDACTED-VAL]');
  });

  it('全角冒号/等号（中文输入法误触，英文变量名 + 全角标点）', () => {
    expect(redactText('api_key：sk-xxxxxxxxxxxxxxxx')).toBe('api_key：[REDACTED-VAL]');
    expect(redactText('token＝abcdefghijklmnop')).toBe('token＝[REDACTED-VAL]');
  });

  it('camelCase secretKey（secret 后直接拼 Key）', () => {
    expect(redactText('secretKey=abcdef1234567890')).toBe('secretKey=[REDACTED-VAL]');
  });

  it('普通中文冒号句不误伤', () => {
    expect(redactText('结论：这个接口返回了空数组')).toBe('结论：这个接口返回了空数组');
  });
});
