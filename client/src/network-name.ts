import { hostNameSchema } from "../../src/client-protocol/host-profile.js";
import { t } from "./i18n.js";

/** Host names already use the entire name limit; adding a suffix must stay valid. */
export function defaultNetworkName(hostName: string): string {
  const candidate = hostNameSchema.safeParse(t("{0}的网络", hostName));
  return candidate.success ? candidate.data : t("我的网络");
}
