import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { it, expect } from "vitest";

it("keeps every whole-card constructor in the translation coverage ledger", async () => {
  const root = path.resolve("src/core"); const names: string[] = [];
  for (const file of (await readdir(root)).filter((name) => name.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, await readFile(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isFunctionDeclaration(node) || !node.name || !/^(render|build).*Card(Compact|Minimal)?$/.test(node.name.text)) continue;
      if (node.type?.kind === ts.SyntaxKind.StringKeyword) continue; // Text-only guidance, not a JSON card.
      names.push(node.name.text);
    }
  }
  const ledger = await readFile("docs/client/card-coverage.md", "utf8");
  const documented = [...ledger.matchAll(/\| `((?:render|build)\w+Card(?:Compact|Minimal)?)` \|/g)].map((match) => match[1]);
  // Scope authorization belongs to the optional Feishu adapter; its translation stays covered as a legacy card fixture.
  expect(names.sort()).toEqual(documented.filter((name) => name !== "renderLarkScopeAuthCard").sort());
});
