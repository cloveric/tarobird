import type { WorkspaceFileDiff, WorkspaceDiffLine } from "../../src/client-protocol/workspace-diff.js";
export type DisplayDiff = Pick<WorkspaceFileDiff, "hunks" | "head"> & { file: { path: string } };
export type DiffRow = { key: string; header?: string; left?: WorkspaceDiffLine; right?: WorkspaceDiffLine; line?: WorkspaceDiffLine };
export function diffRows(file: DisplayDiff, split: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  file.hunks.forEach((hunk, hi) => {
    rows.push({ key: `h${hi}`, header: hunk.header });
    for (let i = 0; i < hunk.lines.length;) {
      const line = hunk.lines[i]!;
      if (!split) { rows.push({ key: `${hi}:${i++}`, line }); continue; }
      if (line.kind === "delete" || line.kind === "add") {
        const old: WorkspaceDiffLine[] = [], fresh: WorkspaceDiffLine[] = [], start = i;
        while (hunk.lines[i]?.kind === "delete") old.push(hunk.lines[i++]!);
        while (hunk.lines[i]?.kind === "add") fresh.push(hunk.lines[i++]!);
        for (let j = 0; j < Math.max(old.length, fresh.length); j++) rows.push({ key: `${hi}:${start}:${j}`, left: old[j], right: fresh[j] });
      } else { rows.push({ key: `${hi}:${i++}`, left: line, right: line }); }
    }
  });
  return rows;
}
export function diffExcerpt(file: DisplayDiff, side: "old" | "new", start: number, end: number): string[] {
  return file.hunks.flatMap(h => h.lines).filter(line => {
    const n = side === "old" ? line.oldLine : line.newLine;
    return n !== null && n >= start && n <= end;
  }).map(line => line.text);
}

/** Conservative monospace columns: wide Unicode must never make a tail unreachable. */
export function diffDisplayColumns(text: string): number {
  let columns = 0;
  for (const character of text) columns += character === "\t" ? 4 : character.codePointAt(0)! > 255 ? 2 : 1;
  return columns;
}
