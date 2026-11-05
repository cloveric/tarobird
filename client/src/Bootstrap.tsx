import { useEffect, useState, type ComponentType } from "react";
import { LoaderCircle } from "lucide-react";
import { HostApp, type WorkspaceProps } from "./HostApp.js";
import { Pairing } from "./Pairing.js";
import { BrandMark } from "./BrandScenes.js";
import { t, useLocale } from "./i18n.js";

// Unpaired devices need identity and connection setup, not chat/cards/settings.
// The service worker still precaches all chunks for offline use. Native shells
// package those same files, so this changes evaluation timing, not availability.
let workspace: ComponentType<WorkspaceProps> | undefined;
let pending: Promise<ComponentType<WorkspaceProps>> | undefined;
function loadWorkspace() {
  if (workspace) return Promise.resolve(workspace);
  return pending ??= import("./App.js").then(module => workspace = module.Workspace).catch(error => {
    pending = undefined; throw error;
  });
}

function WorkspaceLoader(props: WorkspaceProps) {
  useLocale();
  const [View, setView] = useState(() => workspace);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (View) return;
    let active = true;
    setFailed(false);
    void loadWorkspace().then(view => { if (active) setView(() => view); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [View]);
  if (View) return <View {...props}/>;
  return <div className="loading-screen"><BrandMark/>{failed
    // Failed module fetches can remain cached by the JS engine. Reloading clears
    // that module map; pairing and history are already durable, and no workspace
    // (therefore no composer draft) has mounted yet.
    ? <><p role="alert">{t("聊天界面未能加载，请重试。")}</p><button type="button" onClick={() => location.reload()}>{t("重试")}</button></>
    : <span role="status"><LoaderCircle size={16} className="spin"/>{t("正在打开 TaroBird…")}</span>}
  </div>;
}

export default function App() { return <HostApp Workspace={WorkspaceLoader} Pairing={Pairing}/>; }
