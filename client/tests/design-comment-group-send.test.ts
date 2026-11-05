import { describe, expect, it, vi } from "vitest";
import { sendGroupComposerMessage, type GroupReplyMode } from "../src/group-composer-send.js";
import type { HubConnection } from "../src/connection.js";
import type { WorkbenchDraft } from "../src/workbench-draft.js";

const draft:WorkbenchDraft={context:{kind:"design",target:{deviceId:"device",windowId:"window",tabId:"design"},revision:0},files:[],designComments:["c_1111111111"],designCommentVersions:{c_1111111111:"a".repeat(64)}};
const frame={v:1 as const,type:"message.send" as const,clientMsgId:"send",conversationId:"conversation",text:"design comments",attachments:[],mentions:["one","two"],workbench:draft.context};
const connection=()=>({state:{status:"online",groupReplyGuardAvailable:true,groupDiscussionRecoveryAvailable:true},cache:{draft:vi.fn(async()=>undefined),saveDraft:vi.fn(),clearDraftIfMatches:vi.fn()},send:vi.fn(),http:vi.fn(async()=>{throw new Error("unexpected_http");})});
describe("design comments in group composer",()=>{
  it("refuses automatic discussion before POST, send or clearing its source draft",async()=>{
    const c=connection(),mode:GroupReplyMode={conversationId:"conversation",mode:"sequential",revision:"r"};
    await expect(sendGroupComposerMessage(c as unknown as HubConnection,frame,mode,new AbortController().signal,undefined,undefined,undefined,draft)).rejects.toThrow("设计评论暂不支持自动群讨论");
    expect(c.http).not.toHaveBeenCalled();expect(c.send).not.toHaveBeenCalled();expect(c.cache.saveDraft).not.toHaveBeenCalled();expect(c.cache.clearDraftIfMatches).not.toHaveBeenCalled();
  });
  it("preserves the association in a normal guarded group message",async()=>{
    const c=connection(),mode:GroupReplyMode={conversationId:"conversation",mode:"mentions",revision:"r"};
    await sendGroupComposerMessage(c as unknown as HubConnection,frame,mode,new AbortController().signal,undefined,undefined,undefined,draft);
    expect(c.send).toHaveBeenCalledWith({...frame,groupReplyGuard:{mode:"mentions",revision:"r"}},draft);expect(c.http).not.toHaveBeenCalled();
  });
  it("preserves the single-Bot ordinary message path inside discussion mode",async()=>{
    const c=connection(),mode:GroupReplyMode={conversationId:"conversation",mode:"sequential",revision:"r"};
    await sendGroupComposerMessage(c as unknown as HubConnection,{...frame,mentions:["one"]},mode,new AbortController().signal,undefined,undefined,undefined,draft);
    expect(c.send).toHaveBeenCalledWith({...frame,mentions:["one"],groupReplyGuard:{mode:"sequential",revision:"r"}},draft);expect(c.http).not.toHaveBeenCalled();
  });
});
