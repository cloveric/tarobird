# iOS 1.4.1 (2) scoped patch

This owner-authorized TestFlight update contains only the iPhone ADHD text-sizing
fix from commit `43c8742`, applied to the published 1.4.1 source
`a1b3d952ee2f8d8b7911fae6d58c9dfe785cec40`. The iOS build counter advances to 2.
Later Google sign-in and documentation changes are excluded from this build.
No GitHub release assets, homepage, other platform binaries or update endpoints
are changed. The existing TestFlight public group and link are retained.

The only production behavior change is a phone-scoped iOS ADHD card CSS rule.
Manual reading size, input sizing, ordinary iPhone chat, iPad, Android and desktop
keep their existing behavior. Host, CLI, protocol, pairing, authentication,
notification identities, signing identities, dependencies and editors are unchanged.
The CLI is not applicable to this presentation-only change.

Use the scoped-patch validation profile. The original failing/passing regression,
15 focused final-source browser cases and independent native WKWebView probes
are inherited with their exact source hashes and evidence boundaries. Run fresh
iOS release-plan checks, source-bound frontend and native builds, packaged-App
simulator smoke, signed IPA verification, privacy scans and Apple upload readback.
Recheck shipped dependency advisories without upgrading. Store counters must not
be reused. Physical iPhone acceptance and Apple processing/review state remain
separate from local simulator and package evidence; record them in release receipts.
