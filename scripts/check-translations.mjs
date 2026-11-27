import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ts = createRequire(new URL("../package.json", import.meta.url))("typescript-api");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");

const placeholders = (value) => [...String(value).matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();

function unwrapString(node) {
  let cur = node;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur))) {
    cur = cur.expression;
  }
  if (cur && (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur))) {
    return cur.text;
  }
  return null;
}

function unwrapObjectLiteral(node) {
  let cur = node;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur))) {
    cur = cur.expression;
  }
  return cur && ts.isObjectLiteralExpression(cur) ? cur : null;
}

function readHostCatalog(relPath, exportName, problems) {
  const absPath = path.join(srcRoot, relPath);
  const source = fs.readFileSync(absPath, "utf8");
  const file = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  let targetObject = null;

  const findExport = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === exportName && node.initializer) {
      targetObject = unwrapObjectLiteral(node.initializer);
    }
    ts.forEachChild(node, findExport);
  };
  findExport(file);

  if (!targetObject) {
    problems.push(`${relPath}: missing exported object ${exportName}`);
    return new Map();
  }

  const entries = new Map();
  for (const prop of targetObject.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      problems.push(`${relPath}: expected string property assignment in ${exportName}`);
      continue;
    }
    const key = ts.isStringLiteral(prop.name) || ts.isNoSubstitutionTemplateLiteral(prop.name) ? prop.name.text : null;
    if (key === null) {
      problems.push(`${relPath}: non-literal property key in ${exportName}`);
      continue;
    }
    if (entries.has(key)) {
      problems.push(`${relPath}: duplicate key in ${exportName}: ${key}`);
      continue;
    }
    const value = unwrapString(prop.initializer);
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`${relPath}: empty or non-literal value for ${key}`);
      continue;
    }
    if (placeholders(key) !== placeholders(value)) {
      problems.push(`${relPath}: placeholder mismatch for ${key}`);
    }
    entries.set(key, value);
  }
  return entries;
}

// 1. Verify App UI catalogs and t(...) call sites.
execFileSync(process.execPath, [path.join(repoRoot, "client/scripts/check-translations.mjs")], {
  stdio: "inherit",
});

// 2. Verify Host message catalogs and hostT(...) call sites.
const problems = [];
const hostEn = readHostCatalog("locales/host-en.ts", "HOST_EN", problems);
const hostJa = readHostCatalog("locales/host-ja.ts", "HOST_JA", problems);

for (const key of hostEn.keys()) {
  if (!hostJa.has(key)) {
    problems.push(`locales/host-ja.ts: missing Japanese translation for ${key}`);
  }
}
for (const key of hostJa.keys()) {
  if (!hostEn.has(key)) {
    problems.push(`locales/host-ja.ts: extra key not in HOST_EN: ${key}`);
  }
}

for (const name of fs.readdirSync(srcRoot, { recursive: true }).filter((entry) => entry.endsWith(".ts"))) {
  const source = fs.readFileSync(path.join(srcRoot, name), "utf8");
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "hostT") {
      const checkArg = (arg) => {
        if (!arg) return;
        if (ts.isConditionalExpression(arg)) {
          checkArg(arg.whenTrue);
          checkArg(arg.whenFalse);
          return;
        }
        if (ts.isParenthesizedExpression(arg)) {
          checkArg(arg.expression);
          return;
        }
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          const key = arg.text;
          if (!hostEn.has(key)) {
            problems.push(`src/${name}: missing HOST_EN translation for ${key}`);
          } else if (placeholders(key) !== placeholders(hostEn.get(key))) {
            problems.push(`src/${name}: HOST_EN placeholder mismatch for ${key}`);
          }
          if (!hostJa.has(key)) {
            problems.push(`src/${name}: missing HOST_JA translation for ${key}`);
          } else if (placeholders(key) !== placeholders(hostJa.get(key))) {
            problems.push(`src/${name}: HOST_JA placeholder mismatch for ${key}`);
          }
        }
      };
      checkArg(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`Host translation catalogs verified (${hostEn.size} keys in en and ja).`);
