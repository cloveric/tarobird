import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveHostDirectory } from "../host-cli/paths.js";
import { requireInitialized } from "../host-cli/setup.js";
import { GoogleAuthorization } from "./auth.js";
import { GoogleDocs } from "./client.js";
import { SystemSecretVault } from "./keychain.js";
import { configureGoogleDocs, googleDocsClient, googleDocsStatus } from "./settings.js";
import { GoogleDocsError } from "./errors.js";

export async function openGoogleDocs(directory: string, clientFile?: string): Promise<GoogleDocs> {
  const client = await googleDocsClient(directory, clientFile);
  return new GoogleDocs(new GoogleAuthorization(client, new SystemSecretVault(client.client_id)));
}
export async function runGoogleDocsCli(argv: string[]): Promise<void> {
  try { await googleDocsCli(argv); }
  catch (error) {
    if (error instanceof GoogleDocsError) throw new Error(`${error.code}: Check the Desktop app OAuth JSON and run tarobot gdocs configure --client-file <file>. See tarobot gdocs --help for setup and host selection.`);
    throw error;
  }
}
async function googleDocsCli(argv: string[]): Promise<void> {
  const args = parseArgs({ args: argv, allowPositionals: true, options: { "state-dir": { type: "string" }, "client-file": { type: "string" }, title: { type: "string" }, file: { type: "string" }, id: { type: "string" }, help: { type: "boolean", short: "h" } } });
  const [command] = args.positionals;
  if (args.values.help || !command) { console.log("TaroBird Google Docs\n  gdocs configure --client-file <installed-app.json>\n  gdocs auth [--client-file <installed-app.json>]\n  gdocs status\n  gdocs logout\n  gdocs create --title <title> --file <UTF-8 file>\n  gdocs update --id <document-id> --file <UTF-8 file>\n\nUses the same host directory as the App/host CLI; select another with --state-dir. configure imports Desktop app OAuth JSON privately into the host. auth --client-file also imports it for subsequent App exports. Open the authorization URL on the host computer. status checks saved credentials only, not Google connectivity. Updates replace the first document tab after checking its revision. Refresh tokens stay in the OS keychain. Text/Markdown is preserved as readable source text."); return; }
  if (!["configure", "auth", "status", "logout", "create", "update"].includes(command)) throw new Error("Unknown gdocs command");
  if (["create", "update"].includes(command) && (!args.values.file || command === "create" && !args.values.title || command === "update" && !args.values.id)) throw new Error("Missing --file and --title/--id. Run gdocs --help.");
  const directory = await resolveHostDirectory(args.values["state-dir"]);
  if (command === "configure" || command === "auth" && args.values["client-file"]) {
    if (!args.values["client-file"]) throw new Error("Missing --client-file. Download a Desktop app OAuth JSON from Google Cloud.");
    await requireInitialized(directory);
    await configureGoogleDocs(directory, args.values["client-file"]);
    if (command === "configure") { console.log(JSON.stringify({ configured: true })); return; }
  }
  if (command === "status") { console.log(JSON.stringify(await googleDocsStatus(() => openGoogleDocs(directory, args.values["client-file"])))); return; }
  const docs = await openGoogleDocs(directory, command === "auth" ? undefined : args.values["client-file"]);
  if (command === "auth") {
    const flow = await docs.authorization.begin(); console.log(`Open this link in your browser on the Hub computer:\n${flow.url}`);
    const cancel = () => flow.cancel(); process.once("SIGINT", cancel);
    try { await flow.completed; console.log("Google Docs authorization saved in the system keychain."); } finally { process.off("SIGINT", cancel); } return;
  }
  if (command === "logout") { await docs.authorization.logout(); console.log("Google Docs authorization revoked and removed."); return; }
  const text = await readFile(path.resolve(args.values.file!), "utf8");
  const result = command === "create" ? await docs.create(args.values.title!, text) : await docs.update(args.values.id!, text);
  console.log(JSON.stringify(result));
}
