import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDesktopUpdateBundle, verifyDesktopUpdateArtifact, readUpdateNotes } from "./desktop-update-manifest.mjs";
export { validateGithubRepository, validateGithubAssetUrl } from "./desktop-update-manifest.mjs";
export const verifyWindowsUpdateArtifact = options => verifyDesktopUpdateArtifact({ ...options, platform: "windows" });
export const createWindowsUpdateBundle = options => createDesktopUpdateBundle({ ...options, platform: "windows" });

async function main() {
  const { values } = parseArgs({ options: {
    installer: { type: "string" }, repository: { type: "string" }, version: { type: "string" },
    "asset-url": { type: "string" }, output: { type: "string" }, "notes-file": { type: "string" },
    "verify-only": { type: "boolean", default: false },
  } });
  const required = values["verify-only"] ? ["installer", "version"] : ["installer", "repository", "version", "asset-url", "output"];
  for (const option of required) if (!values[option]) throw new Error(`--${option} is required`);
  const publicKey = process.env.TAROBOT_UPDATE_PUBLIC_KEY ?? process.env.TAROCUB_UPDATE_PUBLIC_KEY ?? "";
  if (values["verify-only"]) {
    console.log(JSON.stringify(await verifyWindowsUpdateArtifact({ installer: values.installer, publicKey, version: values.version }), null, 2));
    return;
  }
  const notes = values["notes-file"] ? await readUpdateNotes(values["notes-file"]) : "";
  const result = await createWindowsUpdateBundle({ installer: values.installer, repository: values.repository, version: values.version, assetUrl: values["asset-url"], outputDir: values.output, publicKey, notes });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
