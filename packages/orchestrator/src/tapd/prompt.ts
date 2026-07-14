/** TAPD 描述(HTML) → 纯文本摘要（卡片展示用）：去标签、图片记 [图片]、截断。 */
export function tapdSummary(html: string | undefined, maxLen = 120): string {
  if (!html) return '';
  const t = html
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
}

/**
 * 拼注入 claude 的 bug/需求上下文 prompt（多 repo：都已切到各自工作分支，claude 跨 repo 编排）。
 * 传输无关：`im` 决定回推/交互用哪个 CLI（飞书 `agent lark` / 企微 `agent wecom`）。
 */
export function buildTapdPrompt(
  claim: { system: string; title: string; id: string; url: string; branch: string; workspaceId: number; description?: string },
  results: { ok: boolean; repo: string; cwd: string; branch: string; action: string; reason?: string; note?: string }[],
  im: 'lark' | 'wecom' = 'lark',
): string {
  const kind = claim.system === 'bug' ? '缺陷' : '需求';
  const repos = results
    .filter((r) => r.ok)
    .map((r) => `- ${r.cwd}（工作分支 ${r.branch}${r.cwd !== r.repo ? ' · worktree' : ''}${r.note ? ` · ${r.note}` : ''}）`)
    .join('\n');
  // 保留图片引用为 [图片:src] 标记（别把图片信息 strip 没了），其余 HTML 去掉
  const descRaw = claim.description
    ? claim.description
        .replace(/<img[^>]*\bsrc=["']?([^"'\s>]+)[^>]*>/gi, ' [图片:$1] ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .trim()
    : '';
  const hasImg = /\[图片:/.test(descRaw);
  const desc = descRaw ? `\n\n描述/复现：\n${descRaw.slice(0, 1500)}` : '';
  return [
    `我在处理一个 TAPD ${kind}，请帮我${claim.system === 'bug' ? '定位并修复' : '实现'}。`,
    ``,
    `标题：${claim.title}`,
    `TAPD #${claim.id}：${claim.url}`,
    `涉及 repo 及各自的工作分支：`,
    repos || '（无）',
    desc,
    ``,
    `跨 repo 用 cd 或 git -C 操作（都在上面各自的工作分支上）。`,
    ``,
    `你有 TAPD MCP 可用（工具名 mcp__tapd__*）：可读详情、评论、附件、图片。开工前务必：`,
    `- **看评论**：用 mcp__tapd__tapd-get-comments 拉本${kind}(workspace_id=${claim.workspaceId}, id=${claim.id})的评论 —— 需求变更/补充说明/复现细节常在评论里，别只看上面的描述。`,
    hasImg
      ? `- **看图片**：描述里有 [图片:...] 标记；用 mcp__tapd__tapd-get-image 传那个 url/路径拿下载链接(300s有效)，下载后用 Read 查看（或 tapd-get-entity-attachments 看附件）。`
      : `- 若描述/评论里提到截图，用 mcp__tapd__tapd-get-image / tapd-get-entity-attachments 拿链接下载后 Read 查看。`,
    ``,
    `完成流程（务必按序）：`,
    `1. 各 repo 完成改动并提交（commit message 带 "TAPD #${claim.id}"）。`,
    `2. **本地验证**：跑相关单测 / 本地复现，确认${claim.system === 'bug' ? '该缺陷已修复、无回归' : '该需求按预期工作'}。`,
    `   ⚠️ 验证**只能用本地或测试环境** —— **严禁连线上数据库 / 生产环境**。任何涉及线上数据、生产库、`,
    `   写操作、部署的动作，先用 \`agent request-approval\` 说清楚再等我批准，别擅自跑。`,
    `3. 遇到**不确定**（无法复现 / 有多种改法 / 需求不清 / 影响面拿不准 / 缺环境数据）——`,
    `   用 \`agent ${im} ask single|multi|input\` 问我，等我答复再继续，别猜着改。`,
    `4. 验证通过后，**先 \`agent request-approval\` 征得我同意**，再用 tapd MCP 把本${kind} #${claim.id}`,
    `   流转到「已解决/已修复」+ 加评论回填 commit/PR 链接（改状态前先用`,
    `   mcp__tapd__tapd-get-workflows-status-map / get-workflows-all-transitions 查该项目正确的目标状态英文名）。`,
    `5. 全程把关键进展/结论用 \`agent ${im} send-text\` 推给我。`,
  ].join('\n');
}
