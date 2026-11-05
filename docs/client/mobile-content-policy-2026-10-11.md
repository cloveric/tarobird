# Mobile content policy and external Markdown images

The October 11 review identified that bundled mobile pages lacked a content
security policy, while Markdown could automatically load an external image.
This follow-up is based on `6d96613`.

## Behavior

Markdown images now become explicit links with an image label and destination
host. Merely reading a message never creates an image request from its Markdown.
Only absolute HTTP(S) destinations without credentials are actionable;
protocol-relative addresses are normalized to HTTPS. Relative paths, `data:`,
`blob:` and other schemes remain non-clickable descriptions. A linked image
keeps its enclosing link's destination without nesting anchors. Raw HTML remains
disabled. Clicking an external link deliberately visits that external site.

Uploaded image attachments and authenticated link-preview covers keep their
existing authorized download and Blob-preview path. This change does not move
private attachments to an external image service or change file delivery.

## Bundled mobile policy

`client/index.html` carries a baseline policy blocking external passive images
and media before App resources load. The existing Hub response policy and Tauri
policy remain independent additional restrictions.

Every Capacitor `copy` or `sync` runs `capacitor:copy:after`. The hook in
`client/scripts/mobile-csp.mjs` replaces the marker in the copied Android/iOS
HTML with the full native policy:

- Scripts, workers and WebView connections are restricted to the App origin.
- Images allow the App origin, data URLs and Blob previews; media allows the
  App origin and Blob previews.
- Fonts allow the App origin and data URLs; frames allow Blob previews.
- Objects and form submissions are disabled, and the base URL stays local.
- Inline styles remain available for rendered math and UI positioning. Inline
  scripts and evaluated strings are not enabled.

Hub networking uses the certificate-bound native transport plugin. The WebView
policy does not weaken that transport or authorize an otherwise rejected Hub.
The hook rejects a missing/ambiguous marker and remote `server.url` assets;
it changes only the native copy, leaving the browser build's networking intact.

Capacitor 8.5.2 Android injects its trusted native bridge immediately after the
literal `<head>`, before the CSP meta. Preserve that ordering; later App scripts
remain governed by the policy. iOS injects its bridge as a native WKUserScript.
These observations come from the installed SDK sources, not a phone run.

## Verification and remaining gates

- Regression baseline reproduced all seven Markdown-image cases failing before
  the repair. The final focused suite passed ten tests across image parsing and
  both native copy targets, including rejection and browser-copy preservation.
- All fourteen existing Markdown parser parity fixtures passed after updating
  only the intentional unsafe-image output. Math and code transformations keep
  their previous output.
- Client production build and real `cap copy android` / `cap copy ios` passed.
  Both resulting native entry files contained the full policy.
- A built production fixture using the real parser worker was rendered through
  the in-app browser. Formula rendering, code highlighting and a Blob image
  worked. External Markdown images rendered as links; deliberately attempted
  external image and fetch requests produced `img-src` and `connect-src`
  violations. The separate loopback probe server received **zero requests**.
- The pre-completion hook passed root and standalone-relay builds plus
  **250 files / 3,914 tests**, with one explicit skip.

The matching browser regression is `client/e2e/mobile-content-policy.spec.ts`.
Its local rendered actions were checked through CUA; the hosted Playwright run
has not executed because the existing runner-account restriction remains.
Native bridge operation, attachment preview and external-link handling still
need physical Android/iOS acceptance with these copied assets. This is not a
claim of final signed-package or phone acceptance, or browser MITM remediation.
