/**
 * 知识库检索(S7.3 升级版):标题/小节加权 + 段落级摘录。
 * 打分:小节标题命中 ×5,文档标题(文件名)命中 ×3,正文词频 ×1;
 * 摘录定位到首个命中的段落(而不是文档开头)。
 */
export interface KnowledgeDoc {
  name: string;
  content: string;
}

export interface KnowledgeHit {
  name: string;
  score: number;
  excerpt: string;
  matchedHeadings: string[];
}

const MAX_EXCERPT = 400;

export function searchKnowledge(docs: KnowledgeDoc[], query: string): KnowledgeHit[] {
  // 空白切词 + 中文连续段 2-gram:长句问题(「…标准是什么」)也能命中标题关键词
  const words = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const terms = [...new Set(words.flatMap((w) => {
    const segs = w.match(/[一-鿿]{2,}/g) ?? [];
    return [w, ...segs.flatMap((seg) => Array.from({ length: seg.length - 1 }, (_, i) => seg.slice(i, i + 2)))];
  }))];
  if (terms.length === 0 || docs.length === 0) return [];

  const hits: KnowledgeHit[] = [];
  for (const doc of docs) {
    const nameLower = doc.name.toLowerCase();
    const lower = doc.content.toLowerCase();
    // 按行切分:heading(#+ 开头)与其后的段落
    const lines = doc.content.split("\n");
    const sections: Array<{ heading: string | null; text: string; startIdx: number }> = [];
    let current: { heading: string | null; text: string; startIdx: number } = { heading: null, text: "", startIdx: 0 };
    let idx = 0;
    for (const line of lines) {
      if (/^#{1,6}\s+/.test(line)) {
        if (current.text.trim() || current.heading) sections.push(current);
        current = { heading: line.replace(/^#{1,6}\s+/, "").trim(), text: "", startIdx: idx };
      } else {
        current.text += line + "\n";
      }
      idx += line.length + 1;
    }
    if (current.text.trim() || current.heading) sections.push(current);

    let score = 0;
    const matchedHeadings: string[] = [];
    let excerpt = "";
    for (const term of terms) {
      if (nameLower.includes(term)) score += 3;
      for (const sec of sections) {
        if (sec.heading && sec.heading.toLowerCase().includes(term)) {
          score += 5;
          if (!matchedHeadings.includes(sec.heading)) matchedHeadings.push(sec.heading);
        }
        const inText = sec.text.toLowerCase().split(term).length - 1;
        score += inText;
      }
      if (!excerpt) {
        const at = lower.indexOf(term);
        if (at >= 0) {
          const from = Math.max(0, at - 80);
          excerpt = doc.content.slice(from, from + MAX_EXCERPT).trim();
        }
      }
    }
    if (score > 0) {
      hits.push({ name: doc.name, score, excerpt: excerpt || doc.content.slice(0, MAX_EXCERPT), matchedHeadings });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 5);
}
