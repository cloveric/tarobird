import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesignShareRow } from "../src/WorkbenchDesignSharing.js";
import type { DesignShareView } from "../src/workbench-design-collaboration.js";

// The share-list row offered on every device: grantees open, owners may also end,
// and the source device's own (possibly orphaned) shares offer End only. Markup
// only (no browser); the actions themselves are covered by the broker tests.
const word = (_zh: string, en: string) => en;
const view = (patch: Partial<DesignShareView>): DesignShareView => ({ shareId: `ds_${"a".repeat(24)}`, conversationId: "c", designId: "d", format: "canvas", title: "Deck", generation: 1,
  ownerUserId: "owner", ownerName: "Owner", role: "owner", revision: 1, sourceOnline: false, onThisDevice: false, ...patch });
const html = (share: DesignShareView, ending = false) => renderToStaticMarkup(<DesignShareRow share={share} word={word} disabled={false} ending={ending} onOpen={() => {}} onEnding={() => {}} onEnd={() => {}}/>);
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => match[1]);

describe("shared design list row", () => {
  it("offers a grantee Open only", () => {
    expect(buttons(html(view({ role: "editor" })))).toEqual(["Open"]);
  });
  it("offers the owner's other device Open and End", () => {
    expect(buttons(html(view({ role: "owner", onThisDevice: false })))).toEqual(["Open", "End share"]);
  });
  it("offers this device's own (orphaned) share End only, since a source cannot join itself", () => {
    expect(buttons(html(view({ role: "owner", onThisDevice: true })))).toEqual(["End share"]);
  });
  it("asks for confirmation before ending", () => {
    const markup = html(view({ role: "owner", onThisDevice: true }), true);
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("cannot be reopened");
    expect(buttons(markup)).toEqual(["Cancel", "End share"]);
  });
});
