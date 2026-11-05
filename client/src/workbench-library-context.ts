import { createContext } from "react";
import type { HubConnection } from "./connection.js";

export type WorkbenchFileTarget = {
  scope: string; conversationId: string; id: string;
  kind: "whiteboard" | "markdown" | "design"; title: string;
};
export type WorkbenchLibraryHost = { id: string; name: string; connection: HubConnection };
export type WorkbenchFileRequest = { serial: number; host: WorkbenchLibraryHost; file: WorkbenchFileTarget };
/** User-only navigation. Never advertises another conversation to a Bot. */
export const WorkbenchLibraryContext = createContext<{
  hosts: WorkbenchLibraryHost[];
  open(host: WorkbenchLibraryHost, file: WorkbenchFileTarget): Promise<void>;
  request?: WorkbenchFileRequest;
  consumed(serial: number): void;
} | undefined>(undefined);
