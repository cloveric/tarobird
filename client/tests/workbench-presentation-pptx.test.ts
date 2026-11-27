import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDesignSandbox, designAssets } from "../design-assets.js";
import { emptyDesign, emptySlides, applyDesignFiles, designTextFile, decodeDesignFile, validateDesignDocument } from "../src/workbench-design.js";
import { DesignSession } from "../src/workbench-design-session.js";
import { designSystemInstall } from "../src/workbench-design-system.js";
import { locateComment } from "../src/workbench-design-comments.js";
import { workbenchErrorText } from "../src/workbench-error.js";
import { importPptxToSlides } from "../src/workbench-slides-pptx-import.js";

function makeMinimalPng(): Uint8Array {
  // Valid 1x1 transparent PNG
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

function makeSamplePptx(): Uint8Array {
  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`;

  const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`;

  const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="102A43"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10363200" cy="1371600"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:pPr algn="l"/>
            <a:r><a:rPr sz="4800" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Q4 Product Roadmap</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Bullets"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="2514600"/><a:ext cx="6000000" cy="2400000"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="D9E2EC"/></a:solidFill></a:rPr><a:t>Launch Workbench Presentation</a:t></a:r></a:p>
          <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="D9E2EC"/></a:solidFill></a:rPr><a:t>Support PPTX Import &amp; Export</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="4" name="Logo" descr="Brand mark"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rIdImg1"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="8000000" y="2400000"/><a:ext cx="2400000" cy="1800000"/></a:xfrm></p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`;

  const slide1Rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
  <Relationship Id="rIdNotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`;

  const notes1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>Remind audience about Apache-2.0 migration.</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`;

  const slide2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:graphicFrame>
        <p:xfrm><a:off x="914400" y="1200000"/><a:ext cx="10000000" cy="3000000"/></p:xfrm>
        <a:graphic><a:graphicData><a:tbl>
          <a:tr h="600000">
            <a:tc><a:txBody><a:p><a:r><a:t>Milestone</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>Status</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
          <a:tr h="600000">
            <a:tc><a:txBody><a:p><a:r><a:t>Editor Upgrade</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>Complete</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
        </a:tbl></a:graphicData></a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`;

  return zipSync({
    "ppt/presentation.xml": strToU8(presentationXml),
    "ppt/_rels/presentation.xml.rels": strToU8(presentationRels),
    "ppt/slides/slide1.xml": strToU8(slide1Xml),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(slide1Rels),
    "ppt/notesSlides/notesSlide1.xml": strToU8(notes1Xml),
    "ppt/slides/slide2.xml": strToU8(slide2Xml),
    "ppt/media/image1.png": makeMinimalPng(),
  });
}

describe("Workbench Presentation (#90): Apache-2.0 slides editor, PPTX import, comments, history", () => {
  it("imports a multi-slide .pptx into a valid Workbench Presentation with text, bullets, image assets, table, and notes", () => {
    const doc = importPptxToSlides(makeSamplePptx(), { id: "deck_imported", title: "Q4 Roadmap" });
    expect(doc.format).toBe("slides");
    validateDesignDocument(doc);

    const deckJson = JSON.parse(new TextDecoder().decode(decodeDesignFile(doc.files["project/deck.json"])));
    expect(deckJson.v).toBe(4);
    expect(deckJson.title).toBe("Q4 Roadmap");
    expect(deckJson.order).toEqual(["slide-1", "slide-2"]);

    const slide1 = new TextDecoder().decode(decodeDesignFile(doc.files["project/slides/slide-1.html"]));
    expect(slide1).toContain("Q4 Product Roadmap");
    expect(slide1).toContain("Launch Workbench Presentation");
    expect(slide1).toContain("Support PPTX Import &amp; Export");
    expect(slide1).toContain("#102A43");
    expect(slide1).toContain("<aside>");
    expect(slide1).toContain("Remind audience about Apache-2.0 migration.");
    expect(slide1).toMatch(/\/_blob\/[a-f0-9]{32}/);

    const assetKeys = Object.keys(doc.files).filter(k => k.startsWith("project/assets/"));
    expect(assetKeys.length).toBe(1);

    const slide2 = new TextDecoder().decode(decodeDesignFile(doc.files["project/slides/slide-2.html"]));
    expect(slide2).toContain("<table");
    expect(slide2).toContain("Milestone");
    expect(slide2).toContain("Editor Upgrade");
  });

  it("handles concurrent revisions with CAS conflict rejection and Bot read/write receipts", async () => {
    let stored = emptySlides("deck_cas", "CAS Deck");
    const session = new DesignSession(
      stored,
      async () => stored,
      async (expected, next) => {
        if (stored.revision !== expected) throw new Error("design_revision_conflict");
        stored = next;
      },
      () => {},
      { user: () => ({ id: "owner", name: "Owner" }), title: () => "CAS Deck" },
    );

    const read1 = await session.read({});
    expect(read1.revision).toBe(0);

    // Bot publishes a new slide atomically
    const deckJson = JSON.parse(new TextDecoder().decode(decodeDesignFile(stored.files["project/deck.json"])));
    deckJson.order.push("agenda");
    const published = await session.publish("req_1", 0, {
      files: {
        "project/deck.json": { content: JSON.stringify(deckJson), contentType: "application/json" },
        "project/slides/agenda.html": { content: '<section id="agenda"><h2>Agenda</h2></section>', contentType: "text/html" },
      },
    }, () => {}, { kind: "bot", id: "b1", name: "Assistant" });
    expect(published.revision).toBe(1);

    // Stale expectedRevision fails with conflict
    await expect(session.publish("req_2", 0, {
      files: { "project/slides/agenda.html": { content: '<section id="agenda"><h2>Stale</h2></section>', contentType: "text/html" } },
    }, () => {}, { kind: "bot", id: "b1", name: "Assistant" })).rejects.toThrow("design_revision_conflict");

    // Replayed requestId with identical payload returns idempotent receipt
    const replay = await session.publish("req_1", 0, {
      files: {
        "project/deck.json": { content: JSON.stringify(deckJson), contentType: "application/json" },
        "project/slides/agenda.html": { content: '<section id="agenda"><h2>Agenda</h2></section>', contentType: "text/html" },
      },
    }, () => {}, { kind: "bot", id: "b1", name: "Assistant" });
    expect(replay.revision).toBe(1);

    // File-level CAS via applyDesignFiles rejects stale ifMatch
    const { base64, contentType } = designTextFile('<section id="agenda"><h2>Race</h2></section>', "text/html");
    expect(() => applyDesignFiles(stored, {
      "project/slides/agenda.html": { base64, contentType, ifMatch: "0".repeat(64) },
    })).toThrow("design_revision_conflict");
  });

  it("locates Open Artifact JSON slide comment anchors accurately", () => {
    const doc = emptySlides("deck_comments", "Comments Deck");
    const loc = locateComment({ label: "Slide 1 › Title", detail: undefined, anchor: JSON.stringify({ slide: "cover", el: "h1" }) } as never, doc);
    expect(loc.file).toBe("project/slides/cover.html");
    expect(loc.slideId).toBe("cover");
  });

  it("replaces client/vendor/baoyu-slides with Apache-2.0 client/vendor/workbench-slides and verifies hashes", () => {
    expect(existsSync(new URL("../vendor/baoyu-slides", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../skills/baoyu-ppt", import.meta.url))).toBe(false);
    const root = new URL("../vendor/workbench-slides/", import.meta.url);
    expect(existsSync(new URL("LICENSE", root))).toBe(true);
    expect(existsSync(new URL("NOTICE", root))).toBe(true);
    const upstream = JSON.parse(readFileSync(new URL("UPSTREAM.json", root), "utf8"));
    expect(upstream.license).toBe("Apache-2.0");
    expect(upstream.repository).toBe("https://github.com/JimLiu/open-artifact");
    expect(upstream.commit).toMatch(/^[a-f0-9]{40}$/);
    for (const [name, expected] of Object.entries<string>(upstream.files)) {
      const actual = createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex");
      expect(actual).toBe(expected);
    }

    const html = buildDesignSandbox("slides");
    expect(html).toContain("openartifact");
    expect(html).not.toContain("__baoyuSave");

    const files: string[] = [];
    const hook = designAssets().generateBundle!;
    const generate = typeof hook === "function" ? hook : hook.handler;
    generate.call({ emitFile: (file: { fileName: string }) => files.push(file.fileName) } as never, {} as never, {}, false);
    expect(files).toContain("licenses/workbench-slides/LICENSE");
    expect(files).toContain("licenses/workbench-slides/NOTICE");
    expect(files).toContain("licenses/workbench-slides/UPSTREAM.json");
    expect(files.some(name => name.includes("baoyu-slides"))).toBe(false);
  }, 30_000);

  it("rejects zip-bomb archives and oversized entries before full decompression with dedicated error codes", () => {
    // 70 MiB of zeros compresses to ~70 KiB; filter must abort before allocating/inflating it.
    const bomb = zipSync({
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
      "ppt/slides/bomb.xml": new Uint8Array(70 * 1024 * 1024),
    }, { level: 9 });
    expect(bomb.byteLength).toBeLessThan(200_000);
    const start = Date.now();
    expect(() => importPptxToSlides(bomb, { id: "bomb" })).toThrow("slides_invalid_pptx_import");
    expect(Date.now() - start).toBeLessThan(2000);

    // > 512 entries rejected cleanly
    const many: Record<string, Uint8Array> = { "ppt/presentation.xml": strToU8("<p:presentation/>") };
    for (let i = 0; i < 520; i++) many[`ppt/slides/s${i}.xml`] = strToU8("<p:sld/>");
    expect(() => importPptxToSlides(zipSync(many), { id: "many" })).toThrow("slides_invalid_pptx_import");

    // Path traversal / backslash rejected
    const badPath = zipSync({ "ppt\\presentation.xml": strToU8("<p:presentation/>") });
    expect(() => importPptxToSlides(badPath, { id: "badpath" })).toThrow("slides_invalid_pptx_import");

    // Oversized media (> 8 MiB) throws design_file_too_large before decoding
    const bigMedia = zipSync({
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
      "ppt/media/huge.png": new Uint8Array(9 * 1024 * 1024),
    }, { level: 9 });
    expect(() => importPptxToSlides(bigMedia, { id: "bigmedia" })).toThrow("design_file_too_large");

    // Localized error text for both codes
    expect(workbenchErrorText("slides_invalid_pptx_import", "en")).toContain(".pptx");
    expect(workbenchErrorText("slides_invalid_pptx_import", "en")).not.toContain(".tarobot-design.json");
    expect(workbenchErrorText("slides_invalid_pptx_import", "zh")).toContain(".pptx");
    expect(workbenchErrorText("design_file_too_large", "en")).toContain("8 MB");
    expect(workbenchErrorText("design_file_too_large", "zh")).toContain("8 MB");
    // Building the two fixtures (79 MiB deflated at level 9) takes longer than the default 5 s on a busy
    // machine; the importer's own 2 s bound above is unchanged.
  }, 60_000);

  it("partitions >24 positioned shapes into position:relative layers so slides stay editable", () => {
    const shapes = Array.from({ length: 30 }, (_, i) => `
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${i + 2}" name="Box ${i + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="${(i % 6) * 1800000}" y="${Math.floor(i / 6) * 1200000}"/><a:ext cx="1500000" cy="900000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"/><a:t>Item ${i + 1}</a:t></a:r></a:p></p:txBody>
      </p:sp>`).join("\n");
    const pptx = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`),
    });
    const doc = importPptxToSlides(pptx, { id: "deck_30", title: "Thirty Shapes" });
    const html = new TextDecoder().decode(decodeDesignFile(doc.files["project/slides/slide-1.html"]));
    expect((html.match(/<div style="position:relative">/g) ?? []).length).toBe(2);
    expect(html).toContain("Item 1");
    expect(html).toContain("Item 30");
  });

  it("keeps transparent bordered shapes transparent, preserves spTree z-order, transforms grpSp, and sanitizes XML/CSS", () => {
    const slideXml = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:cSld><p:spTree>
        <p:pic>
          <p:nvPicPr><p:cNvPr id="2" name="Backdrop"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
          <p:blipFill><a:blip r:embed="rIdBg"/></p:blipFill>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr>
        </p:pic>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="3" name="Bordered"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="914400" y="914400"/><a:ext cx="4000000" cy="1200000"/></a:xfrm>
            <a:noFill/>
            <a:ln w="38100"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln>
          </p:spPr>
          <p:txBody><a:bodyPr/>
            <a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:latin typeface="Arial;color:#ff0000;opacity:0"/></a:rPr><a:t>Cover &#99999999; Title</a:t></a:r></a:p>
            <a:p><a:pPr algn="r"/><a:r><a:rPr sz="1600"/><a:t>Right subtitle</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
        <p:grpSp>
          <p:grpSpPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="6096000" cy="3429000"/><a:chOff x="0" y="0"/><a:chExt cx="6096000" cy="3429000"/></a:xfrm></p:grpSpPr>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="4" name="Grouped"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="609600" y="342900"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr>
            <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2000"/><a:t>Grouped Label</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </p:grpSp>
      </p:spTree></p:cSld>
    </p:sld>`;
    const slideRels = `<Relationships>
      <Relationship Id="rIdBg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/bg.png"/>
      <Relationship Id="rIdProto" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../toString"/>
    </Relationships>`;
    const pptx = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rIdProto"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rIdProto" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../toString"/></Relationships>`),
      "ppt/slides/slide1.xml": strToU8(slideXml),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(slideRels),
      "ppt/media/bg.png": makeMinimalPng(),
    });
    const doc = importPptxToSlides(pptx, { id: "deck_zorder", title: "ZOrder" });
    const html = new TextDecoder().decode(decodeDesignFile(doc.files["project/slides/slide-1.html"]));
    // Z-order: background <img ...> emitted BEFORE bordered text
    expect(html.indexOf("<img ")).toBeGreaterThan(-1);
    expect(html.indexOf("Cover  Title")).toBeGreaterThan(html.indexOf("<img "));
    // Transparent bordered shape has border:#112233 but NOT background:#112233
    expect(html).toContain("border:");
    expect(html).toContain("solid #112233");
    expect(html).not.toContain("background:#112233");
    // CSS injection stripped and font quoted
    expect(html).toContain("font-family:'Arial'");
    expect(html).not.toContain("color:#ff0000");
    expect(html).not.toContain("opacity:0");
    // Mixed-alignment multi-paragraph box uses regular <div> (not <div data-text>) so styles are preserved
    expect(html).not.toContain("<div data-text");
    expect(html).toContain("text-align:center");
    expect(html).toContain("text-align:right");
    // Grouped shape coordinate transformed: off (6096000 + 609600) / 12192000 * 1920 = 1056px, top (3429000 + 342900) / 6858000 * 1080 = 594px
    expect(html).toContain("left:1056px;top:594px");
    expect((html.match(/Grouped Label/g) ?? []).length).toBe(1);
  });

  it("installs design-system assets without leading slash for slides and with leading slash for canvas", () => {
    const asset = designTextFile('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>', "image/svg+xml");
    const assetId = asset.sha256.slice(0, 32);
    const dsSource = validateDesignDocument({
      schema: 1, id: "brand", format: "design-system", revision: 0, receipts: [],
      files: {
        "project/tokens.json": designTextFile("{}", "application/json"),
        [`project/assets/${assetId}`]: asset,
        "project/snippet.html": designTextFile(`<img src="/_blob/${assetId}">`, "text/html"),
      },
    });
    const identity = { scope: "scope-1", id: "brand", title: "Brand" };
    const slidesTarget = emptySlides("s1", "Deck");
    const slidesInstalled = applyDesignFiles(slidesTarget, designSystemInstall(slidesTarget, dsSource, identity));
    const slidesSnippet = new TextDecoder().decode(decodeDesignFile(slidesInstalled.files["project/ds/system-brand/snippet.html"]!));
    expect(slidesSnippet).toBe(`<img src="project/ds/system-brand/assets/${assetId}">`);

    const canvasTarget = emptyDesign("c1", "Canvas");
    const canvasInstalled = applyDesignFiles(canvasTarget, designSystemInstall(canvasTarget, dsSource, identity));
    const canvasSnippet = new TextDecoder().decode(decodeDesignFile(canvasInstalled.files["project/ds/system-brand/snippet.html"]!));
    expect(canvasSnippet).toBe(`<img src="/project/ds/system-brand/assets/${assetId}">`);
  });

  it("removes deleted skills/baoyu-ppt entries from package.json and leaves no Baoyu skill behind", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect((pkg.files as string[]).some(entry => entry.includes("baoyu-ppt"))).toBe(false);
    // This read skills/baoyu-design/SKILL.md for a stale baoyu-ppt mention; that skill went with the canvas (#89).
    expect((pkg.files as string[]).some(entry => entry.includes("baoyu"))).toBe(false);
    for (const skill of ["baoyu-ppt", "baoyu-design"]) expect(existsSync(new URL(`../../skills/${skill}`, import.meta.url)), skill).toBe(false);
  });
});
