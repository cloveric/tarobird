import { expect, it } from "vitest";
import { readScreenFrame, writeScreenFrame, SCREEN_PACKET_LIMIT } from "../src/client-protocol/screen-wire.js";
const header = { key:true, codec:"vp8" as const,sequence:1,geometryRevision:1,streamGeneration:1,captureMs:12345678,width:1920,height:1080 };
it("round trips a strict 32-byte LE header and exact payload without JSON",()=>{
  const bytes=writeScreenFrame(header,new Uint8Array([1,2,3])); expect(bytes.length).toBe(35);expect(readScreenFrame(bytes)).toEqual(header);expect([...bytes.subarray(32)]).toEqual([1,2,3]);
});
it("rejects bad flags, generations, length, unsafe clock and extreme pixels",()=>{
  for(const change of [{sequence:0},{sequence:0x100000000},{captureMs:NaN},{captureMs:1.5},{captureMs:Number.MAX_SAFE_INTEGER+1},{width:50000},{height:0}])expect(()=>writeScreenFrame({...header,...change},new Uint8Array([1]))).toThrow();
  const bytes=writeScreenFrame(header,new Uint8Array([1]));bytes[1]=2;expect(()=>readScreenFrame(bytes)).toThrow();
  expect(()=>readScreenFrame(new Uint8Array(SCREEN_PACKET_LIMIT+1))).toThrow();
});
it("honors typed array offset instead of accidentally reading adjacent buffer data",()=>{
 const bytes=writeScreenFrame(header,new Uint8Array([1])),wrapped=new Uint8Array(bytes.length+12);wrapped.set(bytes,6);expect(readScreenFrame(wrapped.subarray(6,6+bytes.length))).toEqual(header);
});
