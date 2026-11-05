import path from "node:path";
import { z } from "zod";
import { JsonStore } from "../state/json-store.js";
import { withFileMutex } from "../state/file-mutex.js";
import { CoreGroupModeStore } from "../core/group-mode-store.js";

const schema = z.object({ modes: z.record(z.string().regex(/^gw_[A-Za-z0-9_-]+$/), z.enum(["all", "at"])) });
export class GatewayGroupModeStore {
  private readonly file: string;
  private readonly store: JsonStore<z.infer<typeof schema>>;
  constructor(private readonly stateDir: string) {
    this.file = path.join(stateDir, "gateway-group-mode.json");
    this.store = new JsonStore(this.file, (value) => schema.parse(value));
  }
  async mode(chatId: string): Promise<"all" | "at" | undefined> {
    const mode = (await this.store.read({ modes: {} })).modes[chatId];
    // Older client builds wrote positive overrides into the shared Lark file.
    // Preserve those until an explicit App choice supersedes them.
    return mode ?? (await new CoreGroupModeStore(this.stateDir).isListenAll(chatId) ? "all" : undefined);
  }
  async set(chatId: string, mode: "all" | "at"): Promise<void> {
    schema.parse({ modes: { [chatId]: mode } });
    await withFileMutex(`${this.file}.mutex`, async () => {
      const state = await this.store.read({ modes: {} });
      await this.store.write({ modes: { ...state.modes, [chatId]: mode } });
    });
  }
}
export async function gatewayRequiresMention(stateDir: string, chatId: string, defaultRequiresMention = true): Promise<boolean> {
  const mode = await new GatewayGroupModeStore(stateDir).mode(chatId);
  return mode === undefined ? defaultRequiresMention : mode === "at";
}
