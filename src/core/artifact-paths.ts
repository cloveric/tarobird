import path from "node:path";
import { channelProfile, type ChannelProfile } from "./channel-profile.js";

/** App desktop and headless hosts share these paths for every engine. */
export function workspaceArtifactRoot(
  stateDir: string,
  kind: "input" | "output",
  profile: ChannelProfile = channelProfile(),
): string {
  const prefix = profile === "gateway" ? "tarobot" : "lark";
  return path.join(stateDir, "workspace", `.${prefix}-${kind === "input" ? "files" : "out"}`);
}

/** Keep the existing retention policy for pre-rename App working copies too. */
export function inboundArtifactRoots(stateDir: string): string[] {
  const current = workspaceArtifactRoot(stateDir, "input");
  return channelProfile() === "gateway"
    ? [current, workspaceArtifactRoot(stateDir, "input", "feishu")]
    : [current];
}
