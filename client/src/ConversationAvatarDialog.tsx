import { useContext, useEffect, useState, type RefObject } from "react";
import type { Conversation } from "../../src/client-protocol/index.js";
import { Profiles } from "./Avatar.js";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";

/** Load optional image tools without risking the chat or its draft on failure. */
export function ConversationAvatarDialog({ conversation, returnFocus, close }: {
  conversation: Conversation; returnFocus: RefObject<HTMLElement | null>; close: () => void;
}) {
  const context = useContext(Profiles);
  const [Editor, setEditor] = useState<typeof import("./AvatarEditorDialog.js").default>();
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void import("./AvatarEditorDialog.js").then(module => { if (active) setEditor(() => module.default); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  const label = conversation.type === "group" ? t("群头像") : t("对话头像");
  return Editor && context ? <Editor target={{ kind: "group", id: conversation.id }} conversation={conversation} name={conversation.title} label={label} returnFocus={returnFocus} close={close} saved={close}/> :
    <CreationDialog mobilePage title={t("编辑{0}", label)} close={close} returnFocus={returnFocus} closeLabel={t("关闭头像编辑")}>
      {failed ? <><p role="alert">{t("头像编辑暂不可用，请稍后重试。聊天和草稿已保留。")}</p><button onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>{t("重试")}</button></> : <p role="status">{t("正在加载…")}</p>}
    </CreationDialog>;
}
