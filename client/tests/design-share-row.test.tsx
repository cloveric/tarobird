import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n.js";
import { DesignShareRow, shareErrorText } from "../src/WorkbenchDesignSharing.js";
import type { DesignShareView } from "../src/workbench-design-collaboration.js";

// The share-list row offered on every device: grantees open, owners may also end,
// and the source device's own (possibly orphaned) shares offer End only. Markup
// only (no browser); the actions themselves are covered by the broker tests.
// The row and its error texts use the global UI locale.
beforeAll(() => setLocale("en"));
afterAll(() => setLocale("zh"));
const view = (patch: Partial<DesignShareView>): DesignShareView => ({ shareId: `ds_${"a".repeat(24)}`, conversationId: "c", designId: "d", format: "slides", title: "Deck", generation: 1,
  ownerUserId: "owner", ownerName: "Owner", role: "owner", revision: 1, sourceOnline: false, onThisDevice: false, ...patch });
const html = (share: DesignShareView, ending = false) => renderToStaticMarkup(<DesignShareRow share={share} disabled={false} ending={ending} onOpen={() => {}} onEnding={() => {}} onEnd={() => {}}/>);
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
  it("hides Open for removed canvas shares while letting owners end them and maps errors cleanly", () => {
    const forGuest = html(view({ role: "editor", format: "canvas" }));
    expect(buttons(forGuest)).toEqual([]);
    expect(forGuest).toContain("Canvas removed");
    const forOwner = html(view({ role: "owner", onThisDevice: false, format: "canvas" }));
    expect(buttons(forOwner)).toEqual(["End share"]);
    // Says what happened and where a project on this device can be exported; names no replacement product.
    expect(shareErrorText(new Error("design_canvas_removed"))).toBe("The Baoyu Design canvas has been removed from the Workbench. Projects on this device can be exported in Settings → Workbench files.");
    expect(shareErrorText(new Error("design_share_format_unsupported"))).toBe("Only PPT projects can be shared.");
  });
  it("asks for confirmation before ending", () => {
    const markup = html(view({ role: "owner", onThisDevice: true }), true);
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("cannot be reopened");
    expect(buttons(markup)).toEqual(["Cancel", "End share"]);
  });
});
