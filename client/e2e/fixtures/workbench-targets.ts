import type { WorkbenchActor, WorkbenchBroker } from "../../../src/hub/workbench.js";

/** UI layout assertions count mounted content panels. The chat-local Design
 * opener is a separate command endpoint and deliberately owns no content. */
export async function workbenchContentTargets(broker: WorkbenchBroker, actor: WorkbenchActor) {
  return (await broker.list(actor)).filter(window => !window.capabilities.includes("design.open.v1"));
}
