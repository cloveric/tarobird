import { hostBridge } from "./host-bridge";

export async function saveAs(blob: Blob, filename: string) {
    const value = blob.type.startsWith("application/json")
        ? await blob.text()
        : new Uint8Array(await blob.arrayBuffer());
    if (!await hostBridge.exportWorkspace(filename, value, blob.type || "application/octet-stream")) {
        throw Error("WORKSPACE_EXPORT_DENIED");
    }
}
export default saveAs;
