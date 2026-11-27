import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// The root build pins the JS compiler API; the client's TypeScript 7 compiler
// intentionally exposes only its native CLI.
const ts = createRequire(new URL("../../package.json", import.meta.url))("typescript-api");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const localesDir = path.join(root, "locales");
const dictionary = JSON.parse(fs.readFileSync(path.join(localesDir, "en.json"), "utf8"));
const placeholders = (value) => [...String(value).matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
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
          else if (placeholders(key) !== placeholders(translation)) problems.push(`${name}: placeholder mismatch for ${key}`);
        }
      };
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
const enKeys = Object.keys(dictionary);
const MIN_LOCALE_COVERAGE = 0.95;
for (const localeFile of fs.readdirSync(localesDir).filter((name) => name.endsWith(".json") && name !== "en.json" && name !== "zh.json").sort()) {
  const catalog = JSON.parse(fs.readFileSync(path.join(localesDir, localeFile), "utf8"));
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    problems.push(`${localeFile}: must be a JSON object`);
    continue;
  }
  let translatedCount = 0;
  for (const key of enKeys) {
    if (!(key in catalog)) continue;
    const value = catalog[key];
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`${localeFile}: empty or non-string translation for ${key}`);
      continue;
    }
    if (placeholders(key) !== placeholders(value)) {
      problems.push(`${localeFile}: placeholder mismatch for ${key}`);
    }
    translatedCount += 1;
  }
  for (const extraKey of Object.keys(catalog)) {
    if (!(extraKey in dictionary)) {
      problems.push(`${localeFile}: unknown key not in en.json: ${extraKey}`);
    }
  }
  const coverage = enKeys.length === 0 ? 1 : translatedCount / enKeys.length;
  if (coverage < MIN_LOCALE_COVERAGE) {
    problems.push(`${localeFile}: coverage ${(coverage * 100).toFixed(1)}% (${translatedCount}/${enKeys.length}) is below ${(MIN_LOCALE_COVERAGE * 100).toFixed(0)}%`);
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("UI translation keys and placeholders verified.");
