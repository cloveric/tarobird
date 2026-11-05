import { describe, expect, it } from "vitest";
import { designTextFile, emptyDesign, decodeDesignFile } from "../src/workbench-design.js";
import { locateComment } from "../src/workbench-design-comments.js";

const canvas = (...names:string[]) => {
  const doc=emptyDesign("canvas"),index=JSON.parse(new TextDecoder().decode(decodeDesignFile(doc.files["project/canvas.json"]!)));
  index.boards=Object.fromEntries(names.map(name=>[name,{x:0,y:0,w:880,h:560}]));index.order=names;
  doc.files={"project/canvas.json":designTextFile(JSON.stringify(index),"application/json"),...Object.fromEntries(names.map(name=>[`project/${name}`,designTextFile("<h1>hello</h1>","text/html")]))};return doc;
};
const location=(detail:string,doc=canvas("中文 页面 (第一版)+é.dc.html"))=>locateComment({label:"Review",detail},doc);
const expected=(name:string)=>({file:`project/${name}`,board:name});
const fallback={file:"project/canvas.json"};

describe("exact canvas comment filenames",()=>{
  const name="中文 页面 (第一版)+é.dc.html";
  it("keeps encodeURIComponent parentheses, spaces, literal plus and non-ASCII bytes together",()=>{
    expect(location(`${encodeURIComponent(name)}: #title h1 "说明"`)).toEqual(expected(name));
  });
  it("accepts the exact raw Unicode filename including spaces and parentheses",()=>{
    expect(location(`${name}: #title h1`)).toEqual(expected(name));
  });
  it("handles area labels and wrapping punctuation without making the wrapper part of the filename",()=>{
    expect(location(`Area over ${encodeURIComponent(name)} (whole)`)).toEqual(expected(name));
    expect(location(`(${encodeURIComponent(name)}): #title h1`)).toEqual(expected(name));
  });
  it("keeps decomposed combining marks distinct from precomposed Unicode",()=>{
    const composed="页面 é.dc.html",decomposed="页面 e\u0301.dc.html",doc=canvas(composed,decomposed);
    expect(location(encodeURIComponent(decomposed),doc)).toEqual(expected(decomposed));
    expect(location(composed,doc)).toEqual(expected(composed));
  });
  it("matches a complete longer board before its same-suffix neighbor",()=>{
    const doc=canvas("Same.dc.html","Known Same.dc.html");
    expect(location("Known Same.dc.html: #title",doc)).toEqual(expected("Known Same.dc.html"));
    expect(location("Missing Same.dc.html: #title",doc)).toEqual(fallback);
  });
  it("never suffix-matches inside an unknown filename or a longer extension",()=>{
    const doc=canvas("Same.dc.html");
    for(const detail of ["Other(Same.dc.html).dc.html", "Missing Same.dc.html", "Same.dc.html.bak", "Same.dc.html (whole).dc.html"])
      expect(location(detail,doc),detail).toEqual(fallback);
  });
  it("requires the referenced file to be both listed and present",()=>{
    const doc=canvas("Known.dc.html");doc.files["project/Unlisted.dc.html"]=designTextFile("x");
    expect(location("Unlisted.dc.html",doc)).toEqual(fallback);delete doc.files["project/Known.dc.html"];
    expect(location("Known.dc.html",doc)).toEqual(fallback);
  });
  it("does not return unsafe paths even from a malformed canvas index",()=>{
    const doc=canvas("../outside.dc.html");expect(location("../outside.dc.html",doc)).toEqual(fallback);
  });
  it("retains the existing legacy element-in-file form",()=>{
    expect(location("h1 in Main.dc.html",canvas("Main.dc.html"))).toEqual(expected("Main.dc.html"));
  });
  it("preserves literal plus rather than applying form-urlencoded space conversion",()=>{
    const doc=canvas("A+B.dc.html","A B.dc.html");
    expect(location("A+B.dc.html",doc)).toEqual(expected("A+B.dc.html"));
    expect(location("A%2bB.dc.html",doc)).toEqual(expected("A+B.dc.html"));
    expect(location("A%20B.dc.html",doc)).toEqual(expected("A B.dc.html"));
  });
});
