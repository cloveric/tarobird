import { describe, expect, it } from "vitest";
import { reportChartDomain } from "../src/report-chart-domain.js";

describe("report chart display domains", () => {
  it("uses a padded visible range for lines while bars retain their zero baseline", () => {
    const values = [1400, 1550, 1700];
    const line = reportChartDomain(values, "line"), bar = reportChartDomain(values, "bar");
    expect(line.minimum).toBeGreaterThan(0);
    expect(line.minimum).toBeLessThan(1400); expect(line.maximum).toBeGreaterThan(1700);
    expect(line.position(1700) - line.position(1400)).toBeGreaterThan(.5);
    expect(bar.minimum).toBe(0); expect(bar.ticks).toContain(0);
    expect(values).toEqual([1400, 1550, 1700]);
  });
  it("recalculates from visible series, not hidden outliers", () => {
    const all = reportChartDomain([1400, 1700, 10_000], "line");
    const visible = reportChartDomain([1400, 1700], "line");
    expect(visible.maximum).toBeLessThan(all.maximum);
    expect(visible.minimum).toBeGreaterThan(0);
  });
  it("keeps negative ranges negative and marks zero for crossing series and negative bars", () => {
    const negative = reportChartDomain([-1700, -1400], "line");
    expect(negative.maximum).toBeLessThan(0);
    const crossing = reportChartDomain([-4, 2], "line");
    expect(crossing.ticks).toContain(0);
    expect(crossing.position(-4)).toBeLessThan(crossing.position(2));
    expect(reportChartDomain([-4, -2], "bar").maximum).toBe(0);
  });
  it.each([0, 1400, -1400])("gives constant %s a nondegenerate flat line", value => {
    const domain = reportChartDomain([value, value], "line");
    expect(domain.minimum).toBeLessThan(value); expect(domain.maximum).toBeGreaterThan(value);
    expect(domain.position(value)).toBeGreaterThan(.2); expect(domain.position(value)).toBeLessThan(.8);
    expect(domain.ticks.length).toBeGreaterThanOrEqual(3);
    const bar = reportChartDomain([value], "bar");
    expect(bar.minimum).toBeLessThanOrEqual(0); expect(bar.maximum).toBeGreaterThanOrEqual(0);
  });
  it("does not invent points or tick values for no finite data", () => {
    const empty = reportChartDomain([NaN, Infinity, -Infinity], "line");
    expect(empty.empty).toBe(true); expect(empty.ticks).toEqual([]); expect(empty.labels).toEqual([]);
  });
  it.each([
    [1e-9, 1.5e-9, 2e-9],
    [1e-300, 2e-300],
    [Number.MIN_VALUE, Number.MIN_VALUE],
    [1e12, 1e12 + .1],
    [1e12, 1e12 + .0001],
    [Number.MAX_VALUE, Number.MAX_VALUE],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ])("keeps finite bounds, readable distinct ticks and valid positions for %j", (...values) => {
    for (const kind of ["line", "bar"] as const) {
      const domain = reportChartDomain(values, kind);
      expect(domain.empty).toBe(false); expect(domain.minimum).toBeLessThan(domain.maximum);
      for (const value of [domain.minimum, domain.maximum, ...domain.ticks]) expect(Number.isFinite(value)).toBe(true);
      for (const value of values) {
        expect(domain.minimum).toBeLessThanOrEqual(value); expect(domain.maximum).toBeGreaterThanOrEqual(value);
        expect(domain.position(value)).toBeGreaterThanOrEqual(-1e-10); expect(domain.position(value)).toBeLessThanOrEqual(1 + 1e-10);
      }
      expect(new Set(domain.labels).size).toBe(domain.ticks.length);
      expect(domain.labels.every(label => !/NaN|Infinity/.test(label))).toBe(true);
      expect(domain.ticks.length).toBeLessThanOrEqual(7);
    }
  });
});
