import type { ReactNode } from "react";
import "./explanation-list.css";

/** Keep consequences scannable without hiding them behind an extra click. */
export function ExplanationList({ items }: { items: { label: string; description: ReactNode }[] }) {
  return <dl className="explanation-list">{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.description}</dd></div>)}</dl>;
}
