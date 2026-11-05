import { Monitor } from "lucide-react";
import { t } from "./i18n.js";
import "./host-source-badge.css";

/** A location hint, not a host switch: row actions stay bound to their owner. */
export function HostSourceBadge({ name, header = false }: { name: string; header?: boolean }) {
  const label = t("运行于 {0}", name);
  return <span className={`host-source-badge${header ? " runtime-host-label header-host-source" : ""}`} title={label} aria-label={label}>
    <Monitor size={12} aria-hidden="true"/><span>{header && <span className="host-source-prefix">{label.slice(0, label.indexOf(name))}</span>}{name}{header && <span className="host-source-prefix">{label.slice(label.indexOf(name) + name.length)}</span>}</span>
  </span>;
}
