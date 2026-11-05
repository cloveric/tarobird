import { ListOrdered } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import { t } from "./i18n.js";

/** A scheduler marker is a record of the discussion, not editable user speech. */
export function GroupDiscussionInput({ message, name }: { message: Message; name: string }) {
  const marker = message.groupDiscussion;
  if (marker?.role !== "input") return null;
  return <div className="group-discussion-input-content" role="note">
    <ListOrdered size={14} aria-hidden="true"/>
    <span>{marker.blind ? t("独立首轮") : t("第 {0}/{1} 轮", marker.round ?? 1, marker.maxRounds ?? 1)}</span>
    <strong>{name}</strong>
    <span>{(marker.attempt ?? 1) > 1 ? t("重新发言") : t("讨论发言")}</span>
  </div>;
}
