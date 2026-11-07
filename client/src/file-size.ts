/** Binary units, as used across File Center. */
export function bytes(value: number): string { const units = ["B", "KiB", "MiB", "GiB", "TiB"]; let n = value, index = 0; while (n >= 1024 && index < units.length - 1) { n /= 1024; index++; } return `${n.toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`; }
