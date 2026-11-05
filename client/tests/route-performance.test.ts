import { expect, it } from "vitest";
import { RoutePerformance } from "../src/route-performance.js";
const health = (url: string, latency: number) => ({ url, latency, status: "reachable" as const });
it("ranks observed quality rather than route category and puts recent failures last", () => {
  const quality = new RoutePerformance(), lan = health("LAN", 200), vpn = health("Tailscale", 40), relay = health("VPS", 20);
  for (let i = 0; i < 3; i++) for (const sample of [lan, vpn, relay]) quality.observe(sample, i * 30000);
  expect(quality.rank([lan, vpn, relay], 60000).map(r => r.url)).toEqual(["VPS", "Tailscale", "LAN"]);
  quality.failed(relay.url, 60000); quality.observe(relay, 61000);
  expect(quality.rank([lan, vpn, relay], 61000)[0]?.url).toBe(vpn.url);
});
it("requires several warm samples and a meaningful sustained latency improvement", () => {
  const quality = new RoutePerformance(), active = health("active", 240), next = health("next", 80);
  quality.observe(active, 0); quality.observe(next, 0);
  expect(quality.worthwhile(next, active, 0)).toBe(false);
  for (let i = 1; i < 4; i++) { quality.observe(active, i * 30000); quality.observe(next, i * 30000); }
  expect(quality.worthwhile(next, active, 90000)).toBe(true);
  const small = health("small", 220); for (let i = 0; i < 4; i++) quality.observe(small, i * 30000);
  expect(quality.worthwhile(small, active, 90000)).toBe(false);
});
it("does not switch to a known poor transfer path merely for lower ping", () => {
  const quality = new RoutePerformance(), active = health("active", 240), next = health("next", 80);
  for (let i = 0; i < 4; i++) { quality.observe(active, i * 30000); quality.observe(next, i * 30000); }
  quality.transferred(active.url, 1024 * 1024, 100); quality.transferred(next.url, 1024 * 1024, 1000);
  expect(quality.worthwhile(next, active, 90000)).toBe(false);
});
it("expires stale samples and forgets removed origins", () => {
  const quality = new RoutePerformance(), a = health("a", 240), b = health("b", 80);
  for (let i = 0; i < 4; i++) { quality.observe(a, i); quality.observe(b, i); }
  quality.retain([a.url]); expect(quality.worthwhile(b, a, 10)).toBe(false);
  quality.observe(b, 1000000); expect(quality.worthwhile(b, a, 1000000)).toBe(false);
});
