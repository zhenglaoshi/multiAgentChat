/**
 * Knowledge extraction 数据模型
 *
 * 一条 KnowledgeEntry = 从 shell 交互提炼出的一个"值得记住的知识点"。
 * 提取器（extractor.ts）用 `claude -p` 分析 sanitize 后的 chunk，产出 0-3 条。
 */

export type KnowledgeKind =
  | 'problem-solved'   // 遇到问题 + 尝试 + 解法
  | 'howto'            // 怎么做 X（有步骤）
  | 'decision'         // 做了什么架构/工具决策及原因
  | 'gotcha'           // 坑 / 边缘 case / 反直觉
  | 'reference';       // 引用型：命令 snippet、URL、配置片段

export interface KnowledgeSource {
  /** 触发 chunk 的原始 prompt / 命令（可为空，如 local task） */
  originalPrompt?: string;
  /** chunk 里出现的命令片段（sanitize 后） */
  commandsRun?: string[];
  /** 提到的文件路径（去噪后） */
  filesTouched?: string[];
  /** 摘录的 output tail（前 500 字符，展示用） */
  outputPreview?: string;
  /** 触发 tab 的 tty */
  tty?: string;
  /** 工作目录 */
  cwd?: string;
  /** chunk 来源 */
  origin: 'feishu' | 'wecom' | 'local' | 'stop-hook';
}

export interface KnowledgeEntry {
  id: string;              // ke-<timestamp-b36>-<rand>
  createdAt: number;       // ms epoch
  kind: KnowledgeKind;
  title: string;           // ≤80 字
  body: string;            // markdown，≤500 字
  tags: string[];          // 3-8 关键词（含项目/技术 stack/领域）
  source: KnowledgeSource;
  /** 触发提取时 chunk 的 SHA-256 前 16 位 —— 用于去重（同一 chunk 别重复提取）*/
  chunkHash: string;
}

/**
 * 抽取时的信号 —— heuristics.ts 判断"这个 chunk 值得跑 LLM 吗"，返回一堆
 * 具体触发理由（用于 audit + 后期用小模型 override）。
 */
export interface ExtractionSignal {
  should: boolean;
  reasons: string[];        // e.g. ['has-error-keyword', 'long-enough', 'has-code-fence']
  charLen: number;
}
