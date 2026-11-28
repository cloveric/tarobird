import { createContext } from "react";
import type { Message } from "../../src/client-protocol/index.js";

/** When provided, a reply's 「本轮改动」 opens the conversation's Files panel at that turn's changes; the Files panel
 * keeps the full diff one click away (「看全部变更」). Without it (other views, fixtures) the entry opens the diff viewer. */
export const RunChangesEntryContext = createContext<((message: Message) => void) | undefined>(undefined);
