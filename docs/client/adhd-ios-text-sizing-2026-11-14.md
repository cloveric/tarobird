# Stable reading size in iPhone ADHD cards

iPhone WebKit can inflate a wide ADHD reply independently of the saved reading
size. After another pane narrows the reply, the inflated text may persist until
the message is remounted or the WebView changes size. An isolated native
WKWebView probe with production CSS reproduced a 12 px reply becoming 20 px
and remaining enlarged after a second pane was added. Applying the rule below
restored 12 px. A smaller fixture separately reproduced recovery after message
remounting or a WebView resize. This explains the reported symptom; the
reporter's exact preceding actions and physical-device screen-width reference
were not observed.

`ios-adaptive.css` sets both text-size-adjust properties to `100%` on iOS
`.adhd-card` elements within `.adhd-shell[data-adhd-device=phone]`. The inherited
rule covers replies and card-local quote,
preview and detail text. It does not change font-size, the user's 11–16 px
choice, the 16 px input floor, virtual-list measurements, pane geometry or
viewport zoom permissions. Android, desktop, ordinary iPhone chat and iPad ADHD
do not match the selector. The existing board device classification is reused;
no new user-agent or screen-width detection is added.

This is App presentation only. Host state, engine adapters and the headless CLI
have no changed behavior or new command.

## Verification

The added assertion in `client/e2e/adhd-keyboard.spec.ts` failed before the fix
with computed text-size-adjust `auto` rather than `100%`. It checks inherited
prose size, manual size changes, one/two-pane transitions, the unchanged input
floor, and iPad, Android/web and outer-shell exclusions. Chromium checks this CSS
contract; desktop Playwright WebKit does not expose the iOS autosizing behavior.

Native evidence comes from a separate, nonpersistent WKWebView probe using
synthetic content and the current production CSS, with the rule removed as a
negative control. It is not a full installed-App or physical-device acceptance
test. The probe does not modify the installed App or its data.

Physical Duo acceptance remains: open a long reply in one wide pane, add a
second pane, change the selected reading size, and repeat after folding or
rotation. Check iPad ADHD visually as well. Do not describe browser CSS checks
or the isolated native probe as those device checks.
