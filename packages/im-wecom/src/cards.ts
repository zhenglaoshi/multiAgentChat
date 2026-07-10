import type { CardSpec, CardTemplate } from 'multiagent-framework';

/**
 * CardSpec → 企业微信 template_card 消息 payload。
 *
 * 企微的 template_card 类型（type 字段）：
 *   - text_notice —— 简单文本 + 按钮，最像我们的 progressCard / approvalCard / ackCard
 *   - news_notice —— 图文卡片，含大图
 *   - button_interaction —— 按钮交互（点击回调）
 *   - vote_interaction —— 单选投票，最像我们的 ask single
 *   - multiple_interaction —— 下拉多选，最像我们的 ask multi（但企微客户端渲染受限）
 *
 * 参考：https://developer.work.weixin.qq.com/document/path/90236
 */

/**
 * 企微 template_card 主色板（jump_list.button_style / horizontal_content_list 里各字段
 * 有 style enum 但主色需靠文案 emoji 表达）。我们用 title emoji 前缀区分紧急度。
 */
function iconForTemplate(t: CardTemplate | undefined, kind: string): string {
  if (kind === 'approval') return t === 'green' ? '✅' : t === 'red' ? '❌' : '🚨';
  if (kind === 'progress') return t === 'green' ? '✓' : t === 'red' ? '✗' : '⏳';
  if (kind === 'ask') return '❓';
  if (kind === 'ack') return t === 'red' ? '❌' : t === 'orange' ? '⚠️' : 'ℹ️';
  return '📌';
}

/**
 * text_notice 通用渲染：适合 progress / approval / ack。
 * button 数量 <=6（企微限制）。
 */
export function renderTextNoticeCard(spec: CardSpec): Record<string, unknown> {
  const icon = iconForTemplate(spec.template, spec.kind);
  const header = `${icon} ${spec.title}`;

  const bodyLines: string[] = [];
  if (spec.body) {
    // 企微 markdown 支持子集：粗体/斜体/删除线/link，不支持 code fence 语言
    bodyLines.push(spec.body);
  }
  if (spec.outputTail) {
    bodyLines.push('```\n' + spec.outputTail + '\n```');
  }
  if (spec.metaLines && spec.metaLines.length > 0) {
    bodyLines.push(spec.metaLines.map((l) => `<span style="color:#888">${l}</span>`).join('\n'));
  }
  const description = bodyLines.join('\n\n');

  const buttons = (spec.actions ?? []).slice(0, 6).map((a) => ({
    text: a.label.slice(0, 12),   // 企微按钮 label 12 字符上限
    style: a.type === 'primary' ? 1 : a.type === 'danger' ? 4 : 2,
    key: encodeButtonKey(a.value),
  }));

  const card: Record<string, unknown> = {
    card_type: 'text_notice',
    main_title: {
      title: header,
      desc: '',
    },
    sub_title_text: '',
    horizontal_content_list: [],
  };
  if (description) {
    (card['emphasis_content'] as unknown) = { title: description.slice(0, 300) };
  }
  if (buttons.length > 0) {
    card['button_selection'] = undefined;
    card['card_action'] = {
      type: 1,
      url: '',
    };
    card['jump_list'] = [];
    card['button_list'] = buttons;
  }
  return card;
}

/**
 * ask single —— 用 vote_interaction 卡（企微原生的"单选投票"）。用户点选后企微
 * 回调事件 EventKey 里带 selection key，daemon 解析后 resolve ask。
 */
export function renderVoteCard(spec: CardSpec): Record<string, unknown> {
  const options = spec.options ?? [];
  const icon = iconForTemplate(spec.template, 'ask');
  return {
    card_type: 'vote_interaction',
    source: { desc: 'multiAgentChat', desc_color: 0 },
    main_title: {
      title: `${icon} ${spec.title}`.slice(0, 26),
      desc: spec.body?.slice(0, 60) ?? '',
    },
    checkbox: {
      question_key: encodeButtonKey({ askKind: 'single' }),
      option_list: options.slice(0, 20).map((opt, i) => ({
        id: `opt-${i}`,
        text: opt.slice(0, 20),
        is_checked: false,
      })),
      mode: 0,   // 0=单选
    },
    submit_button: {
      text: '提交',
      key: encodeButtonKey({ askKind: 'single-submit' }),
    },
  };
}

export function renderMultiSelectCard(spec: CardSpec): Record<string, unknown> {
  const options = spec.options ?? [];
  const selected = new Set(spec.selectedIndices ?? []);
  const icon = iconForTemplate(spec.template, 'ask');
  return {
    card_type: 'multiple_interaction',
    source: { desc: 'multiAgentChat', desc_color: 0 },
    main_title: {
      title: `${icon} ${spec.title}`.slice(0, 26),
      desc: spec.body?.slice(0, 60) ?? '',
    },
    select_list: options.slice(0, 30).map((opt, i) => ({
      question_key: `q-${i}`,
      title: opt.slice(0, 20),
      selected_id: selected.has(i) ? 'yes' : 'no',
      option_list: [
        { id: 'yes', text: '选' },
        { id: 'no', text: '不选' },
      ],
    })),
    submit_button: {
      text: '提交',
      key: encodeButtonKey({ askKind: 'multi-submit' }),
    },
  };
}

/**
 * ask input —— text_notice + 提示语，用户直接在 chat 里回文本，daemon 侧监听。
 */
export function renderAskInputCard(spec: CardSpec): Record<string, unknown> {
  const icon = iconForTemplate(spec.template, 'ask');
  return {
    card_type: 'text_notice',
    main_title: {
      title: `${icon} ${spec.title}`.slice(0, 26),
      desc: '在这个 chat 里直接回复文本消息即可（5 分钟超时；回 /cancel 取消）',
    },
    emphasis_content: {
      title: spec.inputHint ?? '(请回复文本)',
    },
  };
}

/**
 * CardSpec 分发到具体 render 函数。返回 wecom 消息 body 的 template_card 字段。
 */
export function renderWeComCard(spec: CardSpec): Record<string, unknown> {
  if (spec.kind === 'ask') {
    // 根据 options 数量判断 single/multi/input
    const optsCount = spec.options?.length ?? 0;
    if (optsCount === 0) return renderAskInputCard(spec);
    // multi 卡看 selectedIndices 存在（即使为空数组也代表 multi 类型）
    const isMulti = spec.selectedIndices !== undefined;
    return isMulti ? renderMultiSelectCard(spec) : renderVoteCard(spec);
  }
  return renderTextNoticeCard(spec);
}

/**
 * 按钮 key 编码 —— 企微 button.key 上限 128 字符，装原始 value 需要序列化 + 短 hash。
 * 我们直接 JSON.stringify + base64；超长截断（保留 key 字段名 + 关键 id）。
 */
export function encodeButtonKey(value: Record<string, unknown>): string {
  const raw = JSON.stringify(value);
  if (raw.length <= 100) return Buffer.from(raw, 'utf8').toString('base64');
  // 太长时保留 action + askId/tty 之类
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
