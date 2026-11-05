import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// The root build pins the JS compiler API; the client's TypeScript 7 compiler
// intentionally exposes only its native CLI.
const ts = createRequire(new URL("../../package.json", import.meta.url))("typescript-api");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const dictionary = JSON.parse(fs.readFileSync(path.join(root, "locales/en.json"), "utf8"));
const problems = [];
for (const name of fs.readdirSync(root, { recursive: true }).filter((name) => /\.(ts|tsx)$/.test(name))) {
  const source = fs.readFileSync(path.join(root, name), "utf8");
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    // Parse literals rather than matching only double quotes: folder and
    // mobile settings use single quotes too, and escaped keys must round-trip.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const check = (argument) => {
        if (argument && ts.isConditionalExpression(argument)) { check(argument.whenTrue); check(argument.whenFalse); return; }
        if (argument && ts.isParenthesizedExpression(argument)) { check(argument.expression); return; }
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        const key = argument.text, translation = dictionary[key];
        if (typeof translation !== "string" || !translation.trim()) problems.push(`${name}: missing English translation for ${key}`);
        else { const placeholders = (value) => [...value.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(); if (placeholders(key) !== placeholders(translation)) problems.push(`${name}: placeholder mismatch for ${key}`); }
        }
      };
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("UI translation keys and placeholders verified.");
