/**
 * P0-07 修复:config:read 会把密钥字段掩码为 `***`,若渲染层原样保存回写,
 * 真实密钥会被字面量 `***` 永久覆盖。config:save 落盘前调用本函数:
 * 提交文本中值为 `***` 的行,按相同 key(含缩进)从磁盘原文还原真实值。
 * 找不到对应原文行时保留提交值(用户显式输入)。
 */

const MASKED_LINE = /^(\s*[\w.:-]+\s*:\s*)\*\*\*\s*$/;

export function restoreMaskedSecrets(submitted: string, original: string): string {
  if (!submitted.includes("***")) return submitted;
  const sub = submitted.split("\n");
  const orig = original.split("\n");
  const consumed = new Set<number>();

  const findOriginal = (keyPrefix: string): string | null => {
    for (let i = 0; i < orig.length; i++) {
      if (consumed.has(i)) continue;
      if (orig[i]!.startsWith(keyPrefix)) {
        consumed.add(i);
        return orig[i]!;
      }
    }
    return null;
  };

  return sub
    .map((line) => {
      const m = MASKED_LINE.exec(line);
      if (!m) return line;
      const restored = findOriginal(m[1]!);
      return restored ?? line;
    })
    .join("\n");
}
