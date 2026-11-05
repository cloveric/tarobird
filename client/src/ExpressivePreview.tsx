// The dark CLI miniature uses the same tokens as the workspace.
// Decorative only: the radio label carries the name and description.
export function ExpressivePreview({ id }: { id: "cli" }) {
  return <span className="palette-preview expressive-preview" data-palette={id} aria-hidden="true">
    <span className="xp-pane" data-mode="dark">
      <span className="xp-bar"/>
      <span className="xp-prompt"><span className="xp-glyph">&gt;</span><span className="xp-text"/></span>
      <span className="xp-box"><span className="xp-text"/><span className="xp-text"/></span>
      <span className="xp-input"><span className="xp-glyph">&gt;</span><span className="xp-cursor"/></span>
    </span>
  </span>;
}
