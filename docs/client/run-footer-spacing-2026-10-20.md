# Desktop run footer spacing

The desktop run footer used `justify-content: space-between`, placing Process
and Changes at opposite edges of a wide reply. Desktop pointer layouts now put
these related reading actions together with a 16px gap. Stop stays at the trailing
edge. Narrow ADHD panes can wrap naturally; long change summaries remain bounded
and their icons retain their size.

The override is limited to non-scoped run cards, a viewport wider than 760px,
and a fine pointer with hover support. Existing phone/touch, narrow-viewport and
scoped report layouts remain unchanged. This is CSS-only; message/run state,
button handlers, diff data, authentication and the headless CLI are unaffected.
No new strings or dependencies are introduced.

Validation used the installed 1.0.96 production styles plus the exact changed
source stylesheet in isolated Chrome DOM fixtures. Twelve layout cases passed:
wide completed/active runs; 320px, 220px and 180px ADHD panes; long English file
statistics; terminal/paper palettes; unchanged phone, landscape touch, narrow
viewport and scoped report layouts. Three additional checks confirmed 14px icons
and no overflow with long labels after the icon-shrink guard was added.
These checks validate CSS layout, not a newly built App or native WebView.

The mounted repository remained blocked by macOS permissions. Root/client builds
and native macOS/WebKit verification were not run; the known GitHub Actions
billing limitation remains. This change does not install or release an App.
