# Keyboard focus follows the selected accent

The quoted-reply source button used the action `--accent` token, which remains
black/white in Monochrome. Other controls used `--focus`, but that token also
stayed neutral after a Monochrome accent was selected. Tab therefore produced
black outlines alongside accent-coloured controls.

Focus-specific declarations now use the existing semantic `--focus` token.
Monochrome derives it from its selected mark colour and theme ink; its soft ring
uses the same colour. This covers ordinary buttons, reply/quote navigation,
menus, fields, list insets, ADHD controls, queue items, scrollable readers,
Agent Bus and the side-pane keyboard splitter. Sidebar mode underlines keep
their shape and use that focus colour. `tabindex` regions keep their existing
outline geometry and use the same colour when the browser paints an outline.
The photo lightbox retains its white-on-dark focus rules.

Pale swatches use a deeper tone for focus visibility. Own-message bubbles can
stay light in dark mode, so their focus token derives from their own ink. The
readback also found a 1:1 outline/background match on an unaccented dark-theme
user quote; the same scope correction fixes it. Unaccented Monochrome remains
neutral elsewhere. System high-contrast mode retains system focus colours.

This is shared App CSS only: no tab-order, action, navigation, saved preference,
Host protocol or headless CLI changes. CLI-not-applicable: there is no new
capability or command. The App's CLI visual theme keeps its existing palette.
No release, production restart or installed-App update was performed.

## Verification

- Client translation, TypeScript and Vite build passed; standalone Host build
  passed. Five existing Chromium journeys passed: profile focus return, Tab
  through sidebar modes, high-contrast controls, unknown-accent fallback and
  accent text contrast.
- Final rendered readback used actual Tab/Shift+Tab (Option+Tab on WebKit) in
  the App with an isolated loopback Hub. Both Bot reply sources and user quotes
  were read across all eight accent choices, light/dark/system-light/system-dark,
  and desktop/iOS/Android layout attributes. Additional toolbar and ADHD reply
  checks passed. Chromium added a forced-colour check: 195 readbacks; WebKit 194.
- Every target retained keyboard focus and `:focus-visible`; outline colours
  matched their scoped tokens within one RGB level of browser/canvas rounding.
  The minimum measured outline/background contrast was 3.52:1, including the
  previously invisible unaccented user-quote case after the correction.
- The throwaway readback script and JSON/screenshots are held in the local task
  evidence directory. No new persistent test fixture or generated UI asset was
  added to the repository. These are browser results, not native or physical
  phone acceptance.
