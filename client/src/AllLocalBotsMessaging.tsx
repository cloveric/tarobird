import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Network } from "lucide-react";
import { botMessageGrantsSnapshotSchema, type BotMessageGrantsSnapshot } from "../../src/client-protocol/bot-message-grants.js";
import { errorText } from "./BotMessageGrants.js";
import type { HubConnection } from "./connection.js";
import { t } from "./i18n.js";
import { applyLocalMesh, localMeshCounts, missingLocalGrants } from "./local-bot-mesh.js";

const route = "/api/bot-messages/grants";

/** One click in the Bot 通信 tab: every local Bot may message every other local Bot.
 * It uses the existing per-source `local-message-grants` command with the Host's current revision, adds only the
 * missing grants (existing ones and self-grants are untouched), and confirms the result with a fresh read.
 * Revoking stays in Settings → Bot 消息授权. Owner-only; the caller decides when to show it. */
export function AllLocalBotsMessaging({ connection, active }: { connection: HubConnection; active: boolean }) {
  const [view, setView] = useState<BotMessageGrantsSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = useCallback(async (signal?: AbortSignal) => botMessageGrantsSnapshotSchema.parse(await connection.http(route, { signal })), [connection]);
  useEffect(() => {
    if (!active || busy) return;
    const controller = new AbortController();
    read(controller.signal).then(fresh => { if (!controller.signal.aborted && mounted.current && !running.current) setView(fresh); }).catch(() => undefined);
    return () => controller.abort();
  }, [active, busy, read]);
  if (!view || view.bots.length < 2) return null;
  const counts = localMeshCounts(view), done = counts.allowed === counts.total;

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(""); setNotice("");
    let finished = 0;
    const sources = missingLocalGrants(view).length;
    try {
      let fresh = await read();
      if (!mounted.current) return;
      setView(fresh);
      if (fresh.revision !== view.revision) throw new Error("grants_changed");
      await applyLocalMesh(fresh, command => {
        if (!mounted.current) throw new Error("grants_changed");
        return connection.saveBotMessageGrants(command);
      }, receipt => {
        finished += 1;
        if (mounted.current) setView(receipt);
      });
      // A write receipt is not the final word: confirm with a fresh read.
      fresh = await read();
      if (!mounted.current) return;
      setView(fresh);
      if (missingLocalGrants(fresh).length) throw new Error("grants_changed");
      setNotice(t("已开通：本机 {0} 个 Bot 可以相互发消息。", fresh.bots.length));
    } catch (failure) {
      if (!mounted.current) return;
      const reason = failure instanceof Error && failure.message === "grants_changed" ? t("授权又发生了变化，请重新载入后核对。") : errorText(failure);
      setError(finished ? t("已开通 {0}/{1} 个 Bot，之后中断：{2}", finished, sources, reason) : reason);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <div className="workspace-mesh">
    <div className={`workspace-mesh-row${done ? " is-done" : ""}`}>
      <span className="workspace-mesh-icon" aria-hidden="true">{done ? <Check size={14}/> : <Network size={14}/>}</span>
      <span className="workspace-mesh-text">
        <strong>{done ? t("本机所有 Bot 已相互通信") : t("本机所有 Bot 相互通信")}</strong>
        <small>{t("本机 {0} 个 Bot · 已开通 {1}/{2} 条授权", counts.bots, counts.allowed, counts.total)}</small>
      </span>
      {!done && <button type="button" className="workspace-mesh-btn" disabled={busy} onClick={() => void run()}>{busy ? t("正在开通…") : t("一键开通")}</button>}
    </div>
    {(error || notice) && <p className={`workspace-mesh-feedback${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</p>}
  </div>;
}
