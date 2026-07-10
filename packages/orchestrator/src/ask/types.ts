export type AskType = 'single' | 'multi' | 'input';
export type AskStatus = 'pending' | 'answered' | 'cancelled' | 'timeout';

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

export type AskAnswer = AskAnswerSingle | AskAnswerMulti | AskAnswerInput;

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
}
