import ts from 'typescript-api';
import path from 'node:path';
import { readdir, readFile, lstat } from 'node:fs/promises';

const retiredDirectories = ['src/lark', 'src/telegram', 'src/commands', 'adapters/feishu'];
const retiredModules = [
  'src/service', 'src/legacy-index', 'src/runtime/telegram-out',
  'src/runtime/cron-executor', 'src/runtime/cron-runtime',
  'src/tools/telegram-tool-executor', 'src/tools/telegram-tool-registry', 'src/tools/telegram-tool-types',
];
const retiredFiles = [
  'tsconfig.legacy.json', 'scripts/cleanup-legacy-launchd.sh', 'scripts/live-element-stream-probe.mjs',
  ...['start', 'stop', 'status'].flatMap(action => ['sh', 'ps1'].map(extension => `scripts/${action}-instance.${extension}`)),
];
export function retiredTransportPath(value) {
  const name = value.replaceAll('\\', '/');
  return retiredDirectories.some(directory => name === directory || name.startsWith(directory + '/'))
    || retiredModules.includes(name.replace(/\.[cm]?[jt]s$/, '')) || retiredFiles.includes(name);
}

/** Includes erased type imports, re-exports, literal lazy imports/URLs and
 * CommonJS aliases. Comments and schema fixture strings are not module loads. */
export function retiredTransportImports(filename, source) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = new Set(ts.preProcessFile(source, true, true).importedFiles.map(x => x.fileName));
  const createRequireNames = new Set(['createRequire']);
  const moduleNames = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !['node:module', 'module'].includes(statement.moduleSpecifier.text)) continue;
    if (statement.importClause?.name) moduleNames.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) moduleNames.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) if ((item.propertyName ?? item.name).text === 'createRequire') createRequireNames.add(item.name.text);
    }
  }
  const requireNames = new Set(['require']);
  function isModuleRequire(expression) {
    return ts.isCallExpression(expression) && expression.expression.getText(ast) === 'require'
      && expression.arguments.length === 1 && ts.isStringLiteralLike(expression.arguments[0])
      && ['node:module', 'module'].includes(expression.arguments[0].text);
  }
  function collectModuleAliases(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && isModuleRequire(node.initializer)) {
      if (ts.isIdentifier(node.name)) moduleNames.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) {
        if ((element.propertyName ?? element.name).getText(ast) === 'createRequire'
          && ts.isIdentifier(element.name)) createRequireNames.add(element.name.text);
      }
    }
    ts.forEachChild(node, collectModuleAliases);
  }
  collectModuleAliases(ast);
  function isCreateRequire(expression) {
    if (createRequireNames.has(expression.getText(ast))) return true;
    const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
      : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text : undefined;
    return member === 'createRequire' && (moduleNames.has(expression.expression.getText(ast))
      || isModuleRequire(expression.expression));
  }
  function collectAliases(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && isCreateRequire(node.initializer.expression)) requireNames.add(node.name.text);
    ts.forEachChild(node, collectAliases);
  }
  collectAliases(ast);
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression.getText(ast);
      const isResolve = [...requireNames].some(name => callee === `${name}.resolve`);
      // These two verifiers resolve only to assert that the SDK is absent.
      // Loading/importing the same package remains forbidden, even here.
      const absenceProbe = isResolve && node.arguments[0].text === '@larksuiteoapi/node-sdk'
        && ['scripts/verify-standalone-package.mjs', 'scripts/verify-standalone-live.mjs'].includes(filename);
      if (!absenceProbe && (requireNames.has(callee) || isResolve
        || /^(?:vi|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)$/.test(callee))) imports.add(node.arguments[0].text);
    }
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL'
      && node.arguments?.length && ts.isStringLiteralLike(node.arguments[0])) imports.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...imports].filter(specifier => {
    // Only these explicit negative SDK-call canaries may inspect an installed SDK.
    // Ordinary source/test files and package-verifier SDK loads remain forbidden.
    if (['tests/setup-gateway-guard.ts', 'tests/helpers/gateway-no-feishu.cjs'].includes(filename)
      && specifier === '@larksuiteoapi/node-sdk') return false;
    if (!specifier.startsWith('.')) return specifier === '@larksuiteoapi/node-sdk' || specifier.startsWith('@larksuiteoapi/node-sdk/');
    return retiredTransportPath(path.posix.normalize(path.posix.join(path.posix.dirname(filename.replaceAll('\\', '/')), specifier)));
  }).map(specifier => `${filename} -> ${specifier}`);
}

export async function checkRetiredTransportSources(root = process.cwd()) {
  const violations = [];
  async function walk(directory, optional = false) {
    let entries;
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) violations.push(...retiredTransportImports(name, await readFile(path.join(root, name), 'utf8')));
    }
  }
  // Docker's host build stage deliberately has no test or frontend sources.
  await Promise.all([
    ...['src', 'deepseek-harness-plugin/src'].map(directory => walk(directory)),
    ...['tests', 'scripts', 'client/src', 'client/scripts', 'client/tests', 'client/e2e', 'web', 'deepseek-harness-plugin/tests'].map(directory => walk(directory, true)),
  ]);
  for (const name of [...retiredDirectories, ...retiredModules.map(name => name + '.ts'), ...retiredFiles, 'skills/tarocub-service-ops']) {
    const exists = await lstat(path.join(root, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) violations.push(`retired path exists: ${name}`);
  }
  if (violations.length) throw new Error(`Retired transport boundary violated:\n${violations.join('\n')}`);
}
