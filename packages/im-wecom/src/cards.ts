import type { CardSpec, CardTemplate } from 'multiagent-framework';

/**
 * CardSpec → 企业微信 template_card 消息 payload。
 *
 * 企微的 template_card 类型（type 字段）：
 *   - text_notice —— 显示型（button_list 可选，但 button 点击只能跳 URL，不能触发 event）
 *   - button_interaction —— **交互按钮**卡片，button_list 里的按钮 click 会通过
 *       template_card_event 事件把 EventKey 推回 daemon。是我们所有交互卡的基座。
 *   - news_notice —— 图文卡片
 *   - vote_interaction / multiple_interaction —— 内建单选/多选，但 XML 事件格式
 *     跟 button_interaction 不同（SelectedItems 结构），需要额外 parse。**当前实现
 *     不用这两个**，改用 button_interaction + 按钮阵列来对齐飞书的按钮式 ask 卡。
 *
 * 参考：https://developer.work.weixin.qq.com/document/path/90236
 */

function iconForTemplate(t: CardTemplate | undefined, kind: string): string {
  if (kind === 'approval') return t === 'green' ? '✅' : t === 'red' ? '❌' : '🚨';
  if (kind === 'progress') return t === 'green' ? '✓' : t === 'red' ? '✗' : '⏳';
  if (kind === 'ask') return '❓';
  if (kind === 'ack') return t === 'red' ? '❌' : t === 'orange' ? '⚠️' : 'ℹ️';
  return '📌';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * text_notice 卡 —— 纯展示。actions 里若有 URL 跳转会走 card_action.url；
 * 但按钮点击 event 不会推。仅适合 ack / receipt / progress-final 之类的展示卡。
 */
export function renderTextNoticeCard(spec: CardSpec): Record<string, unknown> {
  const icon = iconForTemplate(spec.template, spec.kind);
  const header = truncate(`${icon} ${spec.title}`, 26);

  const bodyLines: string[] = [];
  if (spec.body) bodyLines.push(spec.body);
  if (spec.outputTail) bodyLines.push('```\n' + spec.outputTail + '\n```');
  if (spec.metaLines && spec.metaLines.length > 0) {
    bodyLines.push(spec.metaLines.join(' · '));
  }
  const description = bodyLines.join('\n\n');

  const card: Record<string, unknown> = {
    card_type: 'text_notice',
    main_title: { title: header, desc: '' },
    sub_title_text: '',
    horizontal_content_list: [],
  };
  if (description) {
    card['emphasis_content'] = { title: truncate(description, 300) };
  }
  return card;
}

/**
 * button_interaction 卡 —— 每个 action 一个可点击按钮。点击后企微推
 * template_card_event，daemon 通过 EventKey (base64 编码的 value JSON)
 * 反解出 { action, ... } 后走对应 handler。
 *
 * 用于：ask single 单选、approval 卡的两个按钮、progress 卡的静默/取消按钮。
 */
export function renderButtonInteractionCard(spec: CardSpec): Record<string, unknown> {
  const icon = iconForTemplate(spec.template, spec.kind);
  const header = truncate(`${icon} ${spec.title}`, 26);

  const bodyLines: string[] = [];
  if (spec.body) bodyLines.push(spec.body);
  if (spec.outputTail) bodyLines.push('```\n' + spec.outputTail + '\n```');
  if (spec.metaLines && spec.metaLines.length > 0) {
    bodyLines.push(spec.metaLines.join(' · '));
  }
  const description = bodyLines.join('\n\n');

  // 企微 button 数量上限 6，label 12 字。多余的截断/丢弃并加提示。
  const actions = spec.actions ?? [];
  const buttonList = actions.slice(0, 6).map((a) => ({
    text: truncate(a.label, 12),
    style: a.type === 'primary' ? 1 : a.type === 'danger' ? 4 : 2,
    key: encodeButtonKey(a.value),
  }));
  if (actions.length > 6) {
    bodyLines.push(`_（另有 ${actions.length - 6} 个选项被截断；企微 button 上限 6）_`);
  }

  return {
    card_type: 'button_interaction',
    main_title: { title: header, desc: '' },
    sub_title_text: '',
    horizontal_content_list: [],
    ...(description ? { emphasis_content: { title: truncate(description, 300) } } : {}),
    button_list: buttonList,
  };
}

/**
 * ask input —— text_notice 提示语，用户直接在 chat 里回文本。
 */
export function renderAskInputCard(spec: CardSpec): Record<string, unknown> {
  const icon = iconForTemplate(spec.template, 'ask');
  return {
    card_type: 'text_notice',
    main_title: {
      title: truncate(`${icon} ${spec.title}`, 26),
      desc: '在这个 chat 里直接回复文本消息即可（5 分钟超时；回 /cancel 取消）',
    },
    emphasis_content: {
      title: truncate(spec.inputHint ?? '(请回复文本)', 200),
    },
  };
}

/**
 * ask multi —— **v1 不支持**（企微 multiple_interaction 事件格式复杂）。
 * 后续用 button_interaction + toggle state 实现（每次点击 update_template_card
 * 把按钮 style 改为 primary 表示选中，最后 submit 按钮触发 resolve）。
 * 目前遇到 multi ask 就走这个：只提示 unsupported，用户可以在飞书里选。
 */
export function renderMultiUnsupportedCard(spec: CardSpec): Record<string, unknown> {
  return renderTextNoticeCard({
    ...spec,
    body: `⚠️ 企微暂不支持多选卡片（Day 9 才补）\n请在飞书里选，或用 /cancel 后改成飞书发起。\n\n本次问题：${spec.title}\n可选项：${(spec.options ?? []).map((o, i) => `${i + 1}. ${o}`).join(' / ')}`,
  });
}

/**
 * CardSpec → 具体 render。ask 三种 + 其他 kind 都在这里 dispatch。
 */
export function renderWeComCard(spec: CardSpec): Record<string, unknown> {
  if (spec.kind === 'ask') {
    const optsCount = spec.options?.length ?? 0;
    // input：无 options
    if (optsCount === 0) return renderAskInputCard(spec);
    // multi：selectedIndices 存在（哪怕空数组）
    const isMulti = spec.selectedIndices !== undefined;
    if (isMulti) return renderMultiUnsupportedCard(spec);
    // single：走 button_interaction
    return renderButtonInteractionCard(spec);
  }
  // approval / ack 若有 actions → button_interaction；否则 text_notice
  if (spec.actions && spec.actions.length > 0) return renderButtonInteractionCard(spec);
  return renderTextNoticeCard(spec);
}

/**
 * 按钮 key 编码 —— 企微 button.key 上限 128 字符。value JSON base64 后若超长，
 * 只保留关键字段（action / askId / index / tty / sentAt / approvalId）。
 */
export function encodeButtonKey(value: Record<string, unknown>): string {
  const raw = JSON.stringify(value);
  if (raw.length <= 100) return Buffer.from(raw, 'utf8').toString('base64');
  const compact: Record<string, unknown> = {};
  for (const k of ['action', 'askId', 'index', 'tty', 'sentAt', 'approvalId']) {
    if (value[k] !== undefined) compact[k] = value[k];
  }
  return Buffer.from(JSON.stringify(compact), 'utf8').toString('base64');
}

export function decodeButtonKey(key: string): Record<string, unknown> {
  try {
    const raw = Buffer.from(key, 'base64').toString('utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
