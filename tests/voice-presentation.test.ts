import { expect, it } from "vitest";
import type { CardElement } from "../src/client-protocol/index.js";
import { voiceCardElements } from "../src/client-protocol/voice-presentation.js";

const card = (title: string, name: string): CardElement[] => [
  { type: "markdown", text: `**${title}**` },
  { type: "markdown", text: name },
  { type: "markdown", text: "帮我查询周四的航班。" },
];
it.each(["音频转写完成", "Audio transcription complete", "部分转写完成", "正在转写音频…"])("cleans the generated filename from legacy %s cards without changing history", title => {
  const original = card(title, "voice-1791780593981.m4a");
  expect(voiceCardElements(original)).toEqual([original[0], original[2]]);
  expect(original).toHaveLength(3);
});
it("retains meaningful document names, ordinary cards and transcript mentions of filenames", () => {
  for (const elements of [card("音频转写完成", "项目会议.m4a"), card("文件说明", "voice-1791780593981.m4a")]) expect(voiceCardElements(elements)).toBe(elements);
  const elements = card("音频转写完成", "voice-1791780593981.m4a"); elements[2]!.text = "请检查 voice-1791780593981.m4a 的内容。";
  expect(voiceCardElements(elements)[1]!.text).toContain("voice-1791780593981.m4a");
});
