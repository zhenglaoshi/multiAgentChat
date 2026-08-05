import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir } from 'node:os';
import {
  beijingStamp,
  appendFooterText,
  appendFooterCard,
} from '../packages/im-lark/src/lark/footer-gate.js';

// 出站消息统一页脚：时间（+可选路径）。卡片加 note 灰字、文本加明文行；克隆不改原对象。

describe('beijingStamp', () => {
  it('固定 UTC 时刻 → 北京时间 MM-DD HH:MM', () => {
    // 2026-08-05T10:42Z + 8h = 08-05 18:42 北京
    expect(beijingStamp(new Date('2026-08-05T10:42:00Z'))).toBe('08-05 18:42');
  });
  it('默认当前时间，格式 MM-DD HH:MM', () => {
    expect(beijingStamp()).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('appendFooterText', () => {
  it('末尾追加一行 🕐 时间（无 cwd）', () => {
    const out = appendFooterText('结果摘要');
    expect(out).toMatch(/^结果摘要\n🕐 \d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it('带 cwd → 追加 📁 路径（home 缩写为 ~）', () => {
    const out = appendFooterText('done', `${homedir()}/ihealth-work/fix_005808`);
    expect(out).toContain('📁 ~/ihealth-work/fix_005808');
    expect(out).toMatch(/🕐 \d{2}-\d{2} \d{2}:\d{2} · 📁 /);
  });
  it("cwd 为 '?' → 不显示路径", () => {
    expect(appendFooterText('x', '?')).not.toContain('📁');
  });
});

describe('appendFooterCard', () => {
  const baseCard = () => ({
    header: { title: { tag: 'plain_text', content: 't' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'body' } }],
  });

  it('返回新对象、不改原卡（防同卡发多 chat 累加页脚）', () => {
    const orig = baseCard();
    const out = appendFooterCard(orig);
    expect(out).not.toBe(orig);
    expect(orig.elements).toHaveLength(1); // 原对象未被 mutate
    expect((out as typeof orig).elements).toHaveLength(2);
  });

  it('末尾是 note 灰字，含 🕐 时间', () => {
    const out = appendFooterCard(baseCard()) as ReturnType<typeof baseCard>;
    const note = out.elements[out.elements.length - 1] as {
      tag: string;
      elements: { tag: string; content: string }[];
    };
    expect(note.tag).toBe('note');
    expect(note.elements[0]!.content).toContain('🕐');
    expect(note.elements[0]!.content).toContain("<font color='grey'>");
  });

  it('带 cwd → note 里含 📁 路径', () => {
    const out = appendFooterCard(baseCard(), `${homedir()}/proj`) as ReturnType<typeof baseCard>;
    const note = out.elements[out.elements.length - 1] as { elements: { content: string }[] };
    expect(note.elements[0]!.content).toContain('📁 ~/proj');
  });

  it('schema-2.0 卡（body.elements）→ 页脚加到 body.elements，不改原对象', () => {
    const orig = { schema: '2.0', body: { elements: [{ tag: 'div' }] } };
    const out = appendFooterCard(orig) as typeof orig;
    expect(out).not.toBe(orig);
    expect(orig.body.elements).toHaveLength(1); // 原对象未 mutate
    expect(out.body).not.toBe(orig.body); // body 也浅拷贝了
    expect(out.body.elements).toHaveLength(2);
    const note = out.body.elements[1] as { tag: string; elements: { content: string }[] };
    expect(note.tag).toBe('note');
    expect(note.elements[0]!.content).toContain('🕐');
  });

  it('路径含下划线 fix_005808 → 转义防误斜体', () => {
    const out = appendFooterCard(baseCard(), `${homedir()}/ihealth-work/fix_005808`) as ReturnType<
      typeof baseCard
    >;
    const note = out.elements[out.elements.length - 1] as { elements: { content: string }[] };
    expect(note.elements[0]!.content).toContain('fix\\_005808');
  });

  it('无 elements 的非标准卡 → 原样返回', () => {
    const weird = { foo: 1 };
    expect(appendFooterCard(weird)).toBe(weird);
  });

  it('非对象 → 原样返回', () => {
    expect(appendFooterCard(undefined)).toBe(undefined);
    expect(appendFooterCard('x')).toBe('x');
  });
});

describe('LARK_MSG_FOOTER=0 开关', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('关闭时文本/卡片都原样返回（不加页脚）', () => {
    vi.stubEnv('LARK_MSG_FOOTER', '0');
    expect(appendFooterText('hi')).toBe('hi');
    const card = { elements: [{ tag: 'div' }] };
    expect(appendFooterCard(card)).toBe(card);
  });
});
