import { expect, it } from "vitest";
import { groupMentions } from "../src/group-mentions.js";
const members = [{ id: "alpha", names: ["研究助手", "Research Bot"] }, { id: "beta", names: ["研究助手二", "Beta"] }];
it("accepts names, IDs, spaced aliases and punctuation with longest exact matching", () => {
  expect(groupMentions("@研究助手二，请检查。 @研究助手 好的 @ALPHA! @research bot: 分析", members)).toEqual({ ids: ["beta", "alpha"], unresolved: [] });
  expect(groupMentions("＠研究助手，＠Beta；请共同检查", members)).toEqual({ ids: ["alpha", "beta"], unresolved: [] });
});
it("does not turn email, escaped at signs or Markdown code into recipients", () => {
  expect(groupMentions("mail@alpha \\@beta `@alpha`\n```txt\n@beta\n```\n~~~\n@alpha\n~~~", members)).toEqual({ ids: [], unresolved: [] });
});
it("does not address Bots inside unfinished or longer fenced code blocks", () => {
  expect(groupMentions('请检查代码：\n```text\n@alpha\n@未知', members)).toEqual({ ids: [], unresolved: [] });
  expect(groupMentions('~~~txt\n@beta', members)).toEqual({ ids: [], unresolved: [] });
  expect(groupMentions('````text\n```\n@alpha\n````\n@beta 请看', members)).toEqual({ ids: ['beta'], unresolved: [] });
  expect(groupMentions('```txt\n@alpha\n````\n@beta 请看', members)).toEqual({ ids: ['beta'], unresolved: [] });
});
it("reports unknown and ambiguous names instead of guessing or broadcasting", () => {
  expect(groupMentions("@未知 @研究助手", [...members, { id: "gamma", names: ["研究助手"] }])).toEqual({ ids: [], unresolved: ["未知", "研究助手"], ambiguous: ["研究助手"] });
  expect(groupMentions("@alphabet", members)).toEqual({ ids: [], unresolved: ["alphabet"] });
});

it("full-width mentions preserve recipient intent and reject unknown members", () => {
  expect(groupMentions("＠研究助手 请回答", members)).toEqual({ ids: ["alpha"], unresolved: [] });
  expect(groupMentions("＠未知 请回答", members)).toEqual({ ids: [], unresolved: ["未知"] });
  expect(groupMentions("`＠研究助手` mail＠alpha \\＠beta", members)).toEqual({ ids: [], unresolved: [] });
});

it("resolves Chinese prose mentions without surrounding spaces (C-4)", () => {
  const bots = [{ id: "gg1", names: ["GG1"] }, { id: "cc1", names: ["CC1"] }, ...members];
  expect(groupMentions("请@GG1看一下", bots)).toEqual({ ids: ["gg1"], unresolved: [] });
  expect(groupMentions("@GG1看一下这个", bots)).toEqual({ ids: ["gg1"], unresolved: [] });
  expect(groupMentions("麻烦＠CC1和@GG1一起检查", bots)).toEqual({ ids: ["cc1", "gg1"], unresolved: [] });
  expect(groupMentions("你好@Beta吗", bots)).toEqual({ ids: ["beta"], unresolved: [] });
  // A longer ASCII token is still a different (unknown) name, never a prefix match.
  expect(groupMentions("请@GG12看一下", bots)).toEqual({ ids: [], unresolved: ["GG12看一下"] });
  // CJK-final names keep the strict boundary: "研究助手好" is not "研究助手" + "好".
  expect(groupMentions("请@研究助手好的", bots)).toEqual({ ids: [], unresolved: ["研究助手好的"] });
  expect(groupMentions("请@研究助手，看一下", bots)).toEqual({ ids: ["alpha"], unresolved: [] });
  // Email-like and escaped forms stay plain text.
  expect(groupMentions("发到 user@GG1 或 \\@CC1", bots)).toEqual({ ids: [], unresolved: [] });
});

// C-4 review: widening the start of a mention to Chinese prose must not turn
// other "@" uses into unresolved mentions, which block a group send.
it("starts a mention only after space, punctuation or CJK text, never inside URLs or Latin words", () => {
  const bots = [{ id: "gg1", names: ["GG1"] }, { id: "andr", names: ["Andr"] }, ...members];
  expect(groupMentions("看 https://social.example/@alpha 和 npm 包 pkg/@beta", bots)).toEqual({ ids: [], unresolved: [] });
  expect(groupMentions("写信给 andré@example.com 或 Grüß@example.de", bots)).toEqual({ ids: [], unresolved: [] });
  // An ASCII-final name ends before CJK text, not before another Latin letter.
  expect(groupMentions("请@André看看", bots)).toEqual({ ids: [], unresolved: ["André看看"] });
  expect(groupMentions("@GG1さん、@GG1에게", bots)).toEqual({ ids: ["gg1"], unresolved: [] });
  // CJK quotes open and close a mention like other punctuation.
  expect(groupMentions("「@GG1」和《@研究助手》", bots)).toEqual({ ids: ["gg1", "alpha"], unresolved: [] });
  // Adjacent mentions after a resolved name still need their own boundary.
  expect(groupMentions("@GG1和@Beta一起", bots)).toEqual({ ids: ["gg1", "beta"], unresolved: [] });
});

it('treats scoped packages and email domains as text even beside Chinese prose or matching bot names', () => {
  const bots = members;
  expect(groupMentions('npm i @types/node 和 @scope/pkg-name；我的邮箱@example.com 收不到', bots)).toEqual({ ids: [], unresolved: [] });
  expect(groupMentions('请@alpha 看 @types/node 和中文邮箱@example.com', bots)).toEqual({ ids: ['alpha'], unresolved: [] });
  expect(groupMentions('Java 里 @Override 注解和 @不存在', bots)).toEqual({ ids: [], unresolved: ['Override', '不存在'] });
});

it('preserves full dotted/slashed Bot aliases and keeps prefix collisions explicit', () => {
  const bots = [{ id: 'gpt', names: ['gpt-5.1'] }, { id: 'ds', names: ['DeepSeek-V3.2'] }, { id: 'gg', names: ['GG1'] }, { id: 'types', names: ['types', 'example'] }, { id: 'slash', names: ['Team/Bot'] }];
  expect(groupMentions('@gpt-5.1 请看一下，请@DeepSeek-V3.2回答 @Team/Bot!', bots)).toEqual({ ids: ['gpt', 'ds', 'slash'], unresolved: [] });
  expect(groupMentions('@GG1/CC1 @types/node 邮箱@example.com Hi @GG1.Please check', bots)).toEqual({ ids: [], unresolved: ['GG1/CC1', 'types/node', 'example.com', 'GG1.Please'] });
  expect(groupMentions('@scope/pkg foo@example.net', bots)).toEqual({ ids: [], unresolved: [] });
  expect(groupMentions('@gpt-5.1/agents @DeepSeek-V3.2.Please @Team/Bot.more', bots)).toEqual({ ids: [], unresolved: ['gpt-5.1/agents', 'DeepSeek-V3.2.Please', 'Team/Bot.more'] });
});
