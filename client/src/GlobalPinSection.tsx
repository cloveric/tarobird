import { SidebarListHeading } from "./SidebarListOptions.js";
import type { ReactNode } from "react";
import { Pin } from "lucide-react";
import { t } from "./i18n.js";
import "./global-pins.css";

/** Presentation only: conversations keep their folder and independent group pin. */
export function GlobalPinSection({ children }: { children: ReactNode }) {
  return <section className="global-pin-section" aria-label={t("已全局置顶")}>
    <SidebarListHeading className="sidebar-label mh-section-head global-pin-heading"><span className="mh-section-title"><Pin size={13} aria-hidden="true"/>{t("置顶")}</span></SidebarListHeading>
    {children}
  </section>;
}
