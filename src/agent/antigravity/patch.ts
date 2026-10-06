import type { StructuredPatchHunk } from 'diff';

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Unified diff из шага-результата правки agy (текст между `[diff_block_start]` и `[diff_block_end]`) →
 * ханки в форме `structuredPatch` (то, что ленте даёт Claude в `tool_use_result`). Блоков может быть
 * несколько; нет блока или формат не разобрался — `undefined` (карточка без диффа, не ошибка).
 */
export function parseDiffBlocks(content: string): StructuredPatchHunk[] | undefined {
  const hunks: StructuredPatchHunk[] = [];
  const blocks = content.matchAll(/\[diff_block_start\]\r?\n([\s\S]*?)\r?\n?\[diff_block_end\]/g);
  for (const block of blocks) {
    let hunk: StructuredPatchHunk | undefined;
    for (const line of (block[1] ?? '').split(/\r?\n/)) {
      const header = HEADER.exec(line);
      if (header) {
        hunk = {
          oldStart: Number(header[1]),
          oldLines: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]),
          newLines: header[4] === undefined ? 1 : Number(header[4]),
          lines: [],
        };
        hunks.push(hunk);
        continue;
      }
      if (!hunk) continue;
      const mark = line[0];
      if (mark === ' ' || mark === '-' || mark === '+') hunk.lines.push(line);
      // `\ No newline at end of file` и пустые хвосты пропускаем
    }
  }
  // ханк, у которого не сошлись счётчики, — формат сменился: лучше без диффа, чем с кривым
  for (const h of hunks) {
    const old = h.lines.filter((l) => l[0] !== '+').length;
    const next = h.lines.filter((l) => l[0] !== '-').length;
    if (old !== h.oldLines || next !== h.newLines) return undefined;
  }
  return hunks.length > 0 ? hunks : undefined;
}
