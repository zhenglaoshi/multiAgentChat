export interface PlanStep {
  title: string;            // 步骤简述
  target?: string;          // 建议目标（tab 短名 / 仓库名）；可空
  prompt: string;           // 发给终端 claude 的完整指令
}

export interface Plan {
  id: string;
  goal: string;
  summary: string;
  steps: PlanStep[];
  createdAt: number;
}

export interface PlanContext {
  tabs: { tty: string; cwd?: string; title?: string }[];
  repos: string[];
}
