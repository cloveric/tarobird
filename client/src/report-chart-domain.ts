export interface ReportChartDomain {
  minimum: number;
  maximum: number;
  ticks: number[];
  labels: string[];
  empty: boolean;
  /** Normalized position avoids overflow in (maximum - minimum). */
  position: (value: number) => number;
}

/** Display-only scale. The input rows and inspected values are never changed. */
export function reportChartDomain(values: readonly number[], kind: "line" | "bar"): ReportChartDomain {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { minimum: 0, maximum: 1, ticks: [], labels: [], empty: true, position: () => 0 };
  const dataMin = Math.min(...finite), dataMax = Math.max(...finite);
  const magnitude = Math.max(Math.abs(dataMin), Math.abs(dataMax));
  // Scale by a power of ten so rounded ticks remain useful in original units.
  // The fallback also handles the smallest subnormal finite numbers.
  const scale = magnitude ? 10 ** Math.floor(Math.log10(magnitude)) || magnitude : 1;
  let lower = dataMin / scale, upper = dataMax / scale;
  if (kind === "bar") {
    lower = Math.min(0, lower); upper = Math.max(0, upper);
    if (lower === upper) upper = 1;
  } else {
    const padding = lower === upper ? Math.abs(lower) * .05 || 1 : (upper - lower) * .08;
    lower -= padding; upper += padding;
  }
  // Do not ask doubles for ticks finer than their representable precision.
  const desired = Math.max((upper - lower) / 4, Math.max(Math.abs(lower), Math.abs(upper)) * Number.EPSILON * 2, Number.MIN_VALUE / scale);
  const power = 10 ** Math.floor(Math.log10(desired));
  const fraction = desired / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
  const unscale = (value: number) => {
    const raw = value * scale;
    return Object.is(raw, -0) ? 0 : Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, raw));
  };
  const minimum = unscale(Math.floor(lower / step) * step), maximum = unscale(Math.ceil(upper / step) * step);
  const low = minimum / scale, high = maximum / scale;
  const ticks = [minimum];
  const start = Math.ceil(low / step);
  for (let index = 0; index < 8; index++) {
    let normalized = (start + index) * step;
    if (Math.abs(normalized) < step * 1e-8) normalized = 0;
    if (normalized >= high - step * 1e-8) break;
    const value = unscale(normalized);
    if (value > minimum && value < maximum && !ticks.includes(value)) ticks.push(value);
  }
  if (maximum !== minimum) ticks.push(maximum);
  // A small fraction must not become several labels saying "0"; a large
  // offset with a narrow range must not collapse to identical exponents.
  const scientific = Math.max(Math.abs(minimum), Math.abs(maximum)) >= 1e6 || Math.max(Math.abs(minimum), Math.abs(maximum)) < .001;
  let labels: string[] = [];
  for (let precision = 4; precision <= 17; precision++) {
    const formatter = new Intl.NumberFormat(undefined, { notation: scientific ? "scientific" : "standard", maximumSignificantDigits: precision, useGrouping: false });
    labels = ticks.map(value => formatter.format(value));
    if (new Set(labels).size === ticks.length) break;
  }
  return { minimum, maximum, ticks, labels, empty: false, position: value => (value / scale - low) / (high - low || 1) };
}
