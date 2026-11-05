import { describe, expect, it } from "vitest";
import { galleryImages, messageImages } from "../client/src/image-gallery.js";

describe("message image browsing scope", () => {
  it("retains native and legacy gallery captions in display order", () => {
    expect(galleryImages([{ type: "markdown", text: "封面" }, { type: "image", attachmentId: "a" }, { type: "image", attachmentId: "b", text: "详情" }])).toEqual([{id:"a",title:"封面"},{id:"b",title:"详情"}]);
    expect(messageImages([{type:"text",text:"说明"},{type:"card",elements:[{type:"markdown",text:"封面"},{type:"image",attachmentId:"a"}]},{type:"image",attachmentId:"b",title:"详情"}])).toEqual([{id:"a",title:"封面"},{id:"b",title:"详情"}]);
  });
  it("walks nested card images without using form text as a caption", () => {
    expect(galleryImages([{type:"markdown",text:"问题"},{type:"input",name:"answer"},{type:"image",attachmentId:"a",text:"示意图"}])).toBeUndefined();
    expect(messageImages([{type:"card",elements:[{type:"markdown",text:"问题"},{type:"input",name:"answer"},{type:"columns",children:[{type:"column",children:[{type:"image",attachmentId:"a",text:"示意图"}]}]}]}])).toEqual([{id:"a",title:"示意图"}]);
  });
  it("deduplicates attachment IDs and does not inherit other messages or file blocks", () => {
    expect(messageImages([{type:"image",attachmentId:"a",title:"原图"},{type:"image",attachmentId:"a",title:"重复"},{type:"file",attachmentId:"file",name:"photo.png",mime:"image/png",size:1}])).toEqual([{id:"a",title:"原图"}]);
    expect(messageImages([{type:"image",attachmentId:"b"}])).toEqual([{id:"b",title:undefined}]);
    expect(messageImages([{type:"text",text:"![external](https://example.com/x.png)"}])).toEqual([]);
  });
});
