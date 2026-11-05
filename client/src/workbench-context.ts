import { createContext } from "react";
import type { WorkbenchSource } from "../../src/client-protocol/workbench.js";

/** Entry points retain the owning conversation even when asynchronous loading finishes later. */
export const WorkbenchContext = createContext<{
  openChart(source: WorkbenchSource): Promise<void>;
  openBrowser(url: string): Promise<void>;
  openImage(file: File, attachmentId?: string): Promise<void>;
} | undefined>(undefined);
