# Phone attachment action spacing (PR 64)

PR 64 adds a small visual gap between attachments and their quote/forward icons.
Its original branch used the pre-review PR 62 layout and conflicted with the
subsequently merged hit-target repairs. Restoring those negative outer margins
would make neighbouring media overlap the action buttons again.

The integrated change keeps main's normal-flow, 44-pixel phone targets and moves
the icons inside their existing buttons with six pixels of top padding. It
retains all PR 62 contrast, quoted-source, audio-control and filter repairs, plus
the later search highlighting change. No message ownership, forwarding,
playback, native inset or model logic changes.

The rule remains phone-width-only and limited to the Porcelain and Monochrome
families. Android and iOS retain their existing platform geometry; desktop and
other palette families keep their existing rules. Native audio controls remain
complete. This presentation change has no Host or headless CLI impact.

The focused regression extends `porcelain-followups` to measure the icon's
visible inset and gap as well as real hit testing at the top, middle and bottom
of each target. Existing attachment, voice, phone navigation, reply-source and
search journeys cover integration with the current main branch.

Local validation: 36 Chromium journeys passed; 33 WebKit journeys passed and
the unsupported forced-colour-mode case was skipped. Host and client builds
passed. Screenshots were checked at phone width in light and dark modes. These
browser checks do not establish physical iPhone/Android or native-shell
acceptance. GitHub's original and integrated Source checks and Secret scanning jobs did
not start because of the account's billing/spending-limit restriction; their
failure status is not a test result. No release or installed-App update is part
of this PR integration.

Independent Opus 5.5 xhigh review found no blocker after comparing the candidate
with a separately built main in Chromium and WebKit across attachment types,
phone widths, light/dark themes and desktop/other-palette isolation. Button
positions, touch-target sizes and message-row heights stayed unchanged.
Image-only messages retain their existing extra bottom margin; this PR adds the
same internal spacing to them without normalizing that separate design choice.
WebKit's fractional-pixel boundary hit behavior was identical on main and the
candidate, with no new overlap. Neither observation required widening this fix.
