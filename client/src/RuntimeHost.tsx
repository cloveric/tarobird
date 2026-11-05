import { createContext, useContext } from "react";
import { t } from "./i18n.js";
export const RuntimeHostContext = createContext<string | undefined>(undefined);
/** Hidden host workspaces stay mounted to retain drafts. Portalled previews
 * must follow the owning workspace, rather than document.body visibility. */
export const RuntimeHostActiveContext = createContext(true);
export function HostLocation() { const name = useContext(RuntimeHostContext); return name ? <p className="runtime-host-label">{t("运行于 {0}", name)}</p> : null; }
