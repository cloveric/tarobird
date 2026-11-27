import { it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stageHostUpdate } from "../src/host-cli/update.js";

it("retains bundled native-history component notices when staging an installed CLI", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "history-notices-"));
  const source = path.join(base, "candidate"), state = path.join(base, "state");
  async function file(name: string, content: string | object) {
    const target = path.join(source, name); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  try {
    await file("package.json", { name: "tarobot", version: "1.6.0", private: true, type: "module", engines: { node: ">=20.17.0" }, dependencies: { sqlite3: "6.0.1", zod: "4.1.5" }, tarobotHostUpdate: { format: 1, minHubSchema: 1, maxHubSchema: 27 } });
    await file("standalone-graph.json", { inputs: { "src/index.ts": {} } });
    await file("dist/src/index.js", "if(process.argv[2]!=='--help')throw Error('unexpected stateful probe');console.log('Fixture host');");
    await file("dist/relay-runtime.mjs", "export {};");
    await file("client/dist/index.html", "<!doctype html><title>Fixture</title>");
    await file("npm-shrinkwrap.json", { lockfileVersion: 3 });
    for (const name of ["sqlite3", "zod"]) await file(`node_modules/${name}/package.json`, { name, type: "module", exports: "./index.js" });
    await file("node_modules/sqlite3/index.js", "export default {Database:class{constructor(file,cb){if(file!==':memory:')throw Error('not isolated');queueMicrotask(()=>cb(null));}close(cb){cb(null);}}};");
    await file("node_modules/zod/index.js", "export const z={string(){return {parse(v){return v;}}}};");
    const notice = "Synthetic third-party component notice\n";
    await file("dist/licenses/claude-agent-sdk/LICENSE.md", notice);
    const revision = await stageHostUpdate(state, source);
    const runtime = path.resolve(path.dirname(revision.entrypoint), "../..");
    expect(await readFile(path.join(runtime, "dist/licenses/claude-agent-sdk/LICENSE.md"), "utf8")).toBe(notice);
  } finally { await rm(base, { recursive: true, force: true }); }
}, 30_000);
