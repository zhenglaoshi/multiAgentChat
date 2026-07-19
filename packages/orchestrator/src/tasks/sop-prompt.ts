import type { TaskState } from './types.js';
import { artifactSkeletonHint } from './artifact-schema.js';

/**
 * 构造 SOP 编排 prompt — 注入到 task tab 的主 claude 前面，
 * 告诉它"你是这个任务的 orchestrator，按 stage 顺序调 Task 工具 + 上报 stage 状态"。
 */
export function buildSopWrapperPrompt(task: TaskState, userPrompt: string): string {
  const gateSet = new Set(task.gates);
  const stageLines = task.stages.map((s, i) => {
    const hasGate = gateSet.has(`after-${s}`);
    const tag = hasGate ? '   ⏸ gate' : '';
    const skel = artifactSkeletonHint(s);
    const skelTag = skel ? `   [artifact 骨架: ${skel}]` : '';
    return `  ${i + 1}. ${s}${tag}${skelTag}`;
  });

  const loopLines = task.loops.map(
    (l) => `  - ${l.on} 失败时自动回到 ${l.retryFrom} 重跑（最多 ${l.maxRetries} 次）`,
  );

  return [
    `🎯 [SOP 任务] task-id: ${task.taskId}`,
    ``,
    `你是这个任务的主 agent。默认 stage 序：`,
    ...stageLines,
    ``,
    `🧠 **第一步：判断真正需要哪些 stage**`,
    `先读 [原始用户需求]，对默认 stage 列表里**你判断不必要的**立刻 skip：`,
    `  \`agent task stage --task-id ${task.taskId} --name <stage> --skip --reason "<原因>"\``,
    `例：`,
    `  - "改个错别字" → skip explore/requirement-analyzer/architect/tester/regression-checker，只跑 coder`,
    `  - "调研 X 可行性" → skip coder/tester/regression-checker，只跑 explore/architect`,
    `  - "实现完整新功能" → 全部 stage 跑`,
    `skip 会让该 stage 状态变 'skipped'（不算失败、不触发 loops、artifact 链路自然断在那）。`,
    ``,
    `🔍 **第二步：计划确认（skip 定完后、开工前调一次）**`,
    `  \`agent task plan-review --task-id ${task.taskId}\``,
    `  它把"将跑哪些 / 跳过哪些+原因"推飞书，给用户 ~45s 轻否决：`,
    `  - stdout \`proceed\`（批准或超时）→ 往下开工`,
    `  - stdout \`adjust\`（用户拒绝）→ 你的 skip 判断被否了：重新想要跑哪些（可 \`agent lark ask\` 问用户具体想跑什么），再调一次 plan-review`,
    ``,
    `✨ **第三步：对需要的 stage 按标准 4 步循环**（务必严格遵守，否则 framework 看不到进度）：`,
    `  (1) \`agent task stage --task-id ${task.taskId} --name <stage> --start\``,
    `      （注：Task hook 现在会在你调 Task 时**自动** --start 该 stage；你这步做兜底即可，幂等）`,
    `  (2) \`Task(subagent_type='<stage>', prompt=<给 subagent 的指令>)\``,
    `      告诉 subagent：artifact 默认存到 \`${task.artifactDir}/<stage>.md\`，**按该 stage 的 [artifact 骨架] 写全所需 section**（见上方 stage 列表）`,
    `      并把上一个**实际跑过**的 stage 的 artifact 路径传给它（被 skip 的不算）`,
    `  (3) subagent 返回后：`,
    `      \`agent task stage --task-id ${task.taskId} --name <stage> --end --summary "<一句话>" --artifact <文件路径>\``,
    `      （会按骨架轻校验 artifact；缺 section 会在 stderr 提醒——补上再往下走，别让下游 subagent 饿着）`,
    `      ⚠ 若该 stage 标了 ⏸ gate，此命令会阻塞等飞书人工审批；返回 "approved" 后继续，"rejected" 则停止。`,
    `  (4) 若 subagent 报告失败：`,
    `      \`agent task stage --task-id ${task.taskId} --name <stage> --fail --note "<根因诊断>"\``,
    `      ⚠ **--note 要写清根因**（哪个用例/期望 vs 实际/疑似原因），不是笼统"失败"——loop 会把它带给重跑的 subagent`,
    `      ⚠ stdout 若输出 \`loopback:<stage>\`：framework 已 reset 下游，**从那个 stage 重新跑 (1)~(3)**；`,
    `         **重跑时务必把 stderr 里的「诊断」原样带进该 subagent 的 prompt**，让它针对性修、别盲改`,
    `      ⚠ 若失败连续到重试耗尽：framework 会**弹飞书 gate 问你要不要再试一次**（阻塞等）；批准=再回环、拒绝/超时=任务终止`,
    `      ⚠ stdout 为空（无 loopback，且非上面的 gate）：任务终止，调 \`agent lark send-text\` 告知用户失败原因`,
    ``,
    `🛑 **若收到 "[SOP 中止]" 消息**：用户主动 abort 了 task，**立刻**停止 stage 协议调用。`,
    `   - "soft" 中止：可以调 \`agent lark send-text\` 简短总结已完成 stage 产出后结束`,
    `   - "hard" 中止：不要写收尾，直接停手待命`,
    `   后续任何 \`agent task stage --start/--end\` 都会被 server 拒绝（task 已 failed）`,
    ``,
    ...(loopLines.length > 0
      ? ['失败回环规则（framework 自动处理）：', ...loopLines, '']
      : []),
    `约定：`,
    `  - artifact 目录：${task.artifactDir}（如不存在请先创建）`,
    `  - subagent 之间通过 artifact 文件 handoff，不依赖主 agent 转述全文`,
    `  - 全部需要的 stage 完成后，调 \`agent lark send-text "..."\` 给用户发收尾摘要`,
    ``,
    `[原始用户需求]`,
    userPrompt,
  ].join('\n');
}
