import PptxGenJS from 'pptxgenjs';

// pptxgenjs 的 TS 类型是命名空间导出，构造器在 default 上；运行时已验证可 new。
// 用 any 化的构造器 + slide，避开类型不构造的问题（此渲染文件自包含）。
// node/tsx 的 interop 差异：有的给到构造器本身，有的把它放在 .default 上，取到能 new 的那个
const PptxCtor = ((PptxGenJS as unknown as { default?: unknown }).default ?? PptxGenJS) as { new (): PptxLike };
interface PptxLike {
  layout: string;
  addSlide(): SlideLike;
  writeFile(opts: { fileName: string }): Promise<string>;
}
interface SlideLike {
  background: { color: string };
  addText(text: unknown, opts: Record<string, unknown>): void;
}

export interface ReportDoc {
  title: string;                                   // "2026-06 月报"
  period: string;                                  // "2026-06-01 ~ 2026-06-30"
  author?: string;
  stats: { label: string; value: string }[];       // 概览数字
  sections: { heading: string; bullets: string[] }[];
}

/** 用 pptxgenjs 渲染报告 → .pptx（封面 → 概览数字 → 每 section 一页）。纯 Node，无 python。 */
export async function renderReportPptx(doc: ReportDoc, outPath: string): Promise<string> {
  const p = new PptxCtor();
  p.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in

  // ---- 封面 ----
  const cover = p.addSlide();
  cover.background = { color: '1F2937' };
  cover.addText(doc.title, { x: 0.7, y: 2.4, w: 12, h: 1.3, fontSize: 40, bold: true, color: 'FFFFFF' });
  cover.addText(doc.period, { x: 0.7, y: 3.7, w: 12, h: 0.6, fontSize: 18, color: '9CA3AF' });
  if (doc.author) cover.addText(doc.author, { x: 0.7, y: 6.6, w: 12, h: 0.4, fontSize: 13, color: '9CA3AF' });

  // ---- 概览数字 ----
  if (doc.stats.length) {
    const s = p.addSlide();
    s.addText('概览', { x: 0.7, y: 0.4, w: 12, h: 0.7, fontSize: 26, bold: true, color: '111827' });
    const items = doc.stats.slice(0, 8);
    const cols = Math.min(items.length, 4);
    const cw = 12 / cols;
    items.forEach((st, i) => {
      const x = 0.7 + (i % cols) * cw;
      const y = 1.8 + Math.floor(i / cols) * 2.4;
      s.addText(st.value, { x, y, w: cw - 0.3, h: 1.1, fontSize: 40, bold: true, color: '2563EB', align: 'center' });
      s.addText(st.label, { x, y: y + 1.1, w: cw - 0.3, h: 0.5, fontSize: 14, color: '6B7280', align: 'center' });
    });
  }

  // ---- 每个 section 一页 ----
  for (const sec of doc.sections) {
    const s = p.addSlide();
    s.addText(sec.heading, { x: 0.7, y: 0.4, w: 12, h: 0.7, fontSize: 26, bold: true, color: '111827' });
    const bullets = (sec.bullets.length ? sec.bullets : ['（无）']).map((b) => ({
      text: b,
      options: { bullet: true, fontSize: 16, color: '111827', breakLine: true, paraSpaceAfter: 8 },
    }));
    s.addText(bullets, { x: 0.8, y: 1.4, w: 11.8, h: 5.6, valign: 'top' });
  }

  await p.writeFile({ fileName: outPath });
  return outPath;
}
