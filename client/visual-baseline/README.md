# Visual acceptance

This folder is reserved for **real Feishu desktop reference captures**. No such
captures have been obtained yet. Client-generated screenshots are not references
and do not establish Feishu parity.

## Reproducible client side

From `client/`, run:

```sh
TMPDIR=/tmp/t npm run test:e2e -- card-layout.spec.ts
# Requires: npx playwright install webkit
TMPDIR=/tmp/t npm run test:webkit
```

The test invokes the real card constructors through `tests/gateway-cards.test.ts`
and exports 33 schema-validated, credential-free cases into the ignored
`e2e/fixtures/generated-cards/` directory. Two additional local Markdown samples
exercise long answers and ten tables. The image batch uses local geometric PNG
fixtures, not downloaded or live chat images. Buttons have a local no-op transport.

The test writes 28 desktop light/dark captures covering 14 cases and five mobile
captures to `test-results/card-layout-*/`. It checks page overflow, real weighted
column geometry, narrow screen layout, explicit line breaks, disclosure behavior,
font size, body spacing and dark theme color. The WebKit run uses a separate
`test-results/webkit/` output directory and passes the same checks. These are layout regression checks
and review evidence, not a pixel comparison against Feishu.

To review an individual case, run `npm run visual:fixtures` and `npm run dev`, then
open `/e2e/fixtures/cards.html?case=approval&theme=dark`. Fixture pages are excluded
from the production Vite entry points.

## Reference collection and comparison

For each entry in `manifest.json`, capture the identical fixture in Feishu desktop
in both light and dark themes. Record application version, OS, viewport, zoom,
font size, locale, source date and fixture name. Remove account names and other
private content before saving a reference. Do not send anything to a live chat
without the user's authorization.

Store captures as `feishu/<case>-<theme>.png`, enter the relative path in the
manifest, and compare with the corresponding client artifact side by side.
Review structure, color, hierarchy and spacing; annotate differences and fixes.
Only then change that case's status to `verified`. Empty paths mean missing
evidence. Additional constructor samples are available for interruption, queues,
goals, archive, resume, scope errors and board states.
