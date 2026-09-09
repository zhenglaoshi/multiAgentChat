import type { LetterDetail } from './types.js';

/**
 * 把一封公函渲染成「给人看」的完整文本：抬头 + 正文全文 + 待答项。
 *
 * **喂给 claude 的和推给人看的必须是这同一份输出**——「人看过全文才执行」这道安全边界
 * 成立的前提就是两边逐字节一致，别在调用处各拼各的。
 *
 * 待答项刻意分成「要我答的」和「别人的」两段：多方公函里 `open_items` 混着几方的条目
 * （实测一封三方公函 5 条待答项里只有 1 条是我的），不分开就会去答不该我答的。
 */
export function letterFullText(d: LetterDetail, myAgent: string): string {
  const L = d.latest;
  const lines: string[] = [];
  lines.push(`【议题】${d.subject}`);
  lines.push(
    `【本封】第 ${L.seq} 封 · ${L.kind} · ${L.fromAgent} → ${L.toAgents.join(', ')}${L.createdAt ? ` · ${L.createdAt}` : ''}`,
  );
  if (L.title && L.title !== d.subject) lines.push(`【标题】${L.title}`);
  lines.push('');
  lines.push(L.bodyMd || '(正文为空)');

  const mine = myAgent ? d.openItems.filter((i) => i.ownerAgent === myAgent) : d.openItems;
  const others = myAgent ? d.openItems.filter((i) => i.ownerAgent !== myAgent) : [];
  if (mine.length) {
    lines.push('', `── 待我${myAgent ? `(${myAgent})` : ''}答 ${mine.length} 项 ──`);
    for (const i of mine) lines.push(`[${i.itemId}]${i.due ? `（${i.due} 前）` : ''} ${i.text}`);
  }
  if (others.length) {
    lines.push('', `── 其他方的 ${others.length} 项（不用我答，供了解）──`);
    for (const i of others) {
      lines.push(`[${i.itemId}] @${i.ownerAgent} ${i.text.slice(0, 120)}${i.text.length > 120 ? '…' : ''}`);
    }
  }
  return lines.join('\n');
}
