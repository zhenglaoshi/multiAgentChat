export type AskType = 'single' | 'multi' | 'input' | 'form';
export type AskStatus = 'pending' | 'answered' | 'cancelled' | 'timeout';

/** 多问题表单里的单个问题（form 类型用）。 */
export interface AskFormQuestion {
  title: string;
  type: 'single' | 'multi';
  options: string[];
  /** 允许自由文字回答（对应 AskUserQuestion 的 "Other / chat about this"）。
   *  任一问题为 true → 整个表单走向导式（B），否则一张卡铺完（A）。 */
  allowText?: boolean;
}

export interface AskAnswerSingle {
  kind: 'single';
  index: number;
  value: string;
}

export interface AskAnswerMulti {
  kind: 'multi';
  indices: number[];
  values: string[];
}

export interface AskAnswerInput {
  kind: 'input';
  text: string;
}

/** 多问题表单里单个问题的答案（text = 用户选了"Other"并自由输入）。 */
export interface AskAnswerFormItem {
  q: number;                 // 问题下标
  kind: 'single' | 'multi' | 'text';
  index?: number;            // single
  value?: string;            // single
  indices?: number[];        // multi
  values?: string[];         // multi
  text?: string;             // text（自由输入）
}

export interface AskAnswerForm {
  kind: 'form';
  items: AskAnswerFormItem[];
}

export type AskAnswer = AskAnswerSingle | AskAnswerMulti | AskAnswerInput | AskAnswerForm;

export interface AskRequest {
  id: string;
  chatId: string;
  type: AskType;
  title: string;
  options: string[];         // 空数组表示 input 类型
  createdAt: number;
  status: AskStatus;
  answer?: AskAnswer;
  resolvedAt?: number;
  resolvedBy?: string;
  cardMessageId?: string;
  /** multi 选中的 index 集合（临时状态，供卡片 patch 用） */
  selection: number[];
  /** form 类型：问题列表 */
  questions?: AskFormQuestion[];
  /** form 类型：每题选中的 index 集合（临时状态，供卡片 patch 用） */
  formSelection?: number[][];
  /** form 类型：每题的自由文字答案（选了 Other 并回复文字时填） */
  formText?: (string | undefined)[];
  /** form 向导：当前展示到第几题（0-based）；== questions.length 表示到了提交页 */
  formCursor?: number;
  /** form 向导：当前"武装"了自由输入的题号（下一条文字消息记为该题答案）；undefined=未武装 */
  formTextArmed?: number;
}
