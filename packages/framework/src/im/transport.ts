import type { EventEmitter } from 'node:events';

/**
 * IMTransport · 抽象一个 IM 平台的收发消息能力。飞书（LarkTransport）+ 企微
 * （WeComTransport）都要 implement 此接口。daemon 里 attach 多个 transport 实例
 * 并行工作。
 *
 * chatId 约定：**带 namespace 前缀**，形如：
 *   - 'lark:oc_xxx'
 *   - 'wecom:user:xxx'  （企微 1v1）
 *   - 'wecom:chat:xxx'  （企微群聊）
 * transport 内部把前缀 strip 掉再调 native API。
 */
export interface IMTransport {
  /** transport 类型标识 —— 用于按 chatId 前缀 dispatch */
  readonly kind: IMKind;

  /** 事件总线：'message' / 'cardAction' / 'error' */
  readonly events: EventEmitter;

  /** 起 receiver（WS 长连接 / HTTP endpoint 等） */
  start(): Promise<void>;

  /** 停 receiver，daemon 退出前调 */
  stop(): Promise<void>;

  // ---- 发消息 API（统一签名）----

  /**
   * 发文本。返回 messageId 供后续 patch 用（部分 IM 不支持 patch 消息则可能返回空串）。
   */
  sendText(
    chatId: string,
    text: string,
    opts?: SendTextOptions,
  ): Promise<SendResult>;

  /**
   * 发交互卡片。返回 messageId。
   * card 是**高阶 CardSpec**，各 transport 自己 render 到 native schema。
   */
  sendCard(
    chatId: string,
    card: CardSpec,
  ): Promise<SendResult>;

  /**
   * 更新已发出的卡片（in-place patch）。
   */
  patchCard(
    messageId: string,
    card: CardSpec,
    chatId?: string,     // 部分 IM (wecom) 需要 chatId 才能 patch
  ): Promise<void>;

  /**
   * 发文件（会先 upload 拿 media_id/file_key 再发）。
   */
  sendFile(
    chatId: string,
    path: string,
    opts?: SendFileOptions,
  ): Promise<SendResult>;

  /**
   * 发图片（同 sendFile 但 msgtype 是图片）。
   */
  sendImage(
    chatId: string,
    path: string,
  ): Promise<SendResult>;
}

export type IMKind = 'lark' | 'wecom';

export interface SendTextOptions {
  /** 是否走"应用消息"而非普通聊天（wecom 特有：agent app msg vs chat）*/
  asAppMessage?: boolean;
}

export interface SendFileOptions {
  /** 发的文件名（默认从 path basename 取）*/
  name?: string;
}

export interface SendResult {
  messageId: string;
  raw?: unknown;
}

// ==================================================================
// CardSpec —— 跨 IM 抽象卡片描述
// 只覆盖本项目**实际用的**卡片类型，不做完美映射
// ==================================================================

export type CardKind =
  | 'progress'    // 任务进度卡（含 tail 输出、按钮）
  | 'approval'    // 审批卡（批准 / 拒绝）
  | 'ask'         // agent lark ask 三态：single / multi / input
  | 'ack'         // 简单确认卡
  | 'receipt'    // 收据卡（"已完成 xx"）
  | 'text';       // 兜底：装不下就当纯文本卡显示

export type CardTemplate = 'blue' | 'green' | 'red' | 'yellow' | 'grey' | 'orange';

export interface CardAction {
  label: string;
  type?: 'primary' | 'danger' | 'default';
  value: Record<string, unknown>;   // 点击时回传 daemon 的原始数据
}

export interface CardSpec {
  kind: CardKind;
  title: string;
  template?: CardTemplate;
  /** markdown body（大段落文本 / code fence 之类）*/
  body?: string;
  /** 底部灰色元数据小行 */
  metaLines?: string[];
  /** 按钮 —— transport render 时按平台能力尽量还原 */
  actions?: CardAction[];

  // ---- kind-specific 扩展字段（可选） ----

  /** progress 卡的输出预览（会 wrap 在 code fence 里）*/
  outputTail?: string;
  /** ask 卡：选项列表（single 只出按钮阵列；multi 每选项独立 toggle button）*/
  options?: string[];
  /** ask multi 卡：当前选中的 indices（用于渲染 ☑/☐ 状态）*/
  selectedIndices?: number[];
  /** ask input 卡：让用户在 chat 里回复文本的提示语 */
  inputHint?: string;

  /** 平台特定的补充字段（尽量少用），如 lark 独有 form container；wecom 独有 emoji_id */
  platformExtras?: Record<string, unknown>;
}

// ==================================================================
// Event payloads —— transport 发的事件的统一 shape
// ==================================================================

export interface IMMessageEvent {
  chatId: string;         // namespace 前缀已加
  senderId: string;
  text: string;
  messageId: string;
  raw: unknown;
}

export interface IMCardActionEvent {
  chatId: string;
  operatorId: string;
  action: string;         // value.action 字段
  value: Record<string, unknown>;
  originalMessageId: string;
  raw: unknown;
}

/**
 * chatId helpers：加/去 namespace 前缀。
 */
export function withKindPrefix(kind: IMKind, rawId: string): string {
  return `${kind}:${rawId}`;
}

export function stripKindPrefix(chatId: string): { kind: IMKind | null; rawId: string } {
  const colon = chatId.indexOf(':');
  if (colon < 0) return { kind: null, rawId: chatId };
  const prefix = chatId.slice(0, colon) as IMKind;
  const rawId = chatId.slice(colon + 1);
  if (prefix === 'lark' || prefix === 'wecom') {
    return { kind: prefix, rawId };
  }
  return { kind: null, rawId: chatId };
}
