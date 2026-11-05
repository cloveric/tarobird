import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { copyIntegrationAssets, integrationAssets } from "../scripts/integration-assets.mjs";

it("packages only public integration assets, excluding credentials, recordings, models and caches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "integration-assets-"));
  const source = path.join(root, "source"), target = path.join(root, "target");
  try {
    for (const relative of [...integrationAssets, "integrations/.env.local", "integrations/tingwu-asr/.env.local", "integrations/tingwu-asr/output/transcript.txt", "integrations/qwen3-asr/models/weights.bin", "integrations/qwen3-asr/.venv/private.cfg", "integrations/qwen3-asr/__pycache__/secret.pyc"]) {
      const file = path.join(source, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, integrationAssets.includes(relative) ? "public" : "PRIVATE_SENTINEL");
    }
    await copyIntegrationAssets(source, target);
    const files = (await readdir(target, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => path.relative(target, path.join(e.parentPath, e.name))).sort();
    expect(files).toEqual([...integrationAssets].sort());
    for (const relative of files) expect(await readFile(path.join(target, relative), "utf8")).toBe("public");
    const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    for (const relative of integrationAssets) expect(manifest.files).toContain(relative);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses a public asset replaced by a symlink to private content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "integration-symlink-"));
  try {
    await mkdir(path.join(root, "integrations")); await writeFile(path.join(root, "private"), "PRIVATE_SENTINEL");
    await symlink(path.join(root, "private"), path.join(root, integrationAssets[0]!));
    await expect(copyIntegrationAssets(root, path.join(root, "out"))).rejects.toThrow("regular file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
