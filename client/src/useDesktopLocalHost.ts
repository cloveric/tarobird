import { useEffect, useState } from "react";
import { invoke, isDesktop } from "./desktop-bridge.js";

/** A loopback route is not proof of which host the native shell owns.
 * Unknown native identity is fail-closed: do not expose its route editor. */
export function useDesktopLocalHost(publicKey?: string) {
  const native = isDesktop();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ requested?: string; key?: string; attempt: number; failed?: boolean }>();
  useEffect(() => {
    let active = true;
    const timer = native ? setTimeout(() => { if (active) { active = false; setResult({ requested: publicKey, attempt, failed: true }); } }, 10000) : undefined;
    if (native) void invoke<{ publicKey?: string }>("desktop_host", { action: "status" })
      .then(value => { if (active) { clearTimeout(timer); active = false; setResult({ requested: publicKey, key: value?.publicKey, attempt }); } })
      .catch(() => { if (active) { clearTimeout(timer); active = false; setResult({ requested: publicKey, attempt, failed: true }); } });
    return () => { active = false; clearTimeout(timer); };
  }, [publicKey, attempt, native]);
  const current = result?.requested === publicKey && result?.attempt === attempt;
  return {
    localHost: native && current && !!publicKey && result?.key === publicKey,
    resolved: !native || current && !result?.failed,
    failed: native && current && !!result?.failed,
    retry: () => setAttempt(value => value + 1),
  };
}
