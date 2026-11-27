import "./diff-counts.css";

/** Shared added/removed line counts (+N -N) for workspace rows and diff viewers. */
export function DiffCounts({
  additions,
  deletions,
  className,
}: {
  additions: number | null;
  deletions: number | null;
  className?: string;
}) {
  return (
    <span className={className ? `diff-counts ${className}` : "diff-counts"}>
      <span>+{additions ?? "—"}</span>
      <span>-{deletions ?? "—"}</span>
    </span>
  );
}
