import { expect, it, vi } from "vitest";
import { coalescedReader } from "../src/coalesced-reader.js";
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
it("coalesces a burst behind one active read and publishes the latest follow-up", async () => {
  const finish: ((value: number) => void)[] = [], values: number[] = [];
  const read = vi.fn(() => new Promise<number>(resolve => finish.push(resolve)));
  const reader = coalescedReader(read, value => values.push(value)); reader.request();
  for (let i = 0; i < 100; i++) reader.request();
  expect(read).toHaveBeenCalledTimes(1);
  finish.shift()!(1); await flush(); expect(read).toHaveBeenCalledTimes(2);
  finish.shift()!(101); await flush(); expect(values).toEqual([1, 101]);
  expect(read).toHaveBeenCalledTimes(2); reader.close();
});
it("drops a late result and dirty work after a host registration is retired", async () => {
  let finish!: (value: string) => void;
  const publish = vi.fn(), read = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const reader = coalescedReader(read, publish); reader.request(); reader.request(); reader.close(); reader.request();
  finish("old host"); await flush(); expect(publish).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
});
it("retries on the next revision after a failed read", async () => {
  const publish = vi.fn(), read = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce("latest");
  const reader = coalescedReader(read, publish); reader.request(); await flush(); reader.request(); await flush();
  expect(publish).toHaveBeenCalledExactlyOnceWith("latest"); reader.close();
});
