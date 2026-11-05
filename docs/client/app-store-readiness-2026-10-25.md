# iOS App Store readiness — 2026-10-25

This is a preparation report, not an App Store submission. App Store Connect was queried read-only. No review access, public demo service, or access to the owner's Mac mini was created.

## Confirmed account state

The existing TaroBot record (`com.tarocub.client`, primary locale `zh-Hans`) has an iOS **1.0** version in **PREPARE_FOR_SUBMISSION**. At the time of inspection:

| Area | Observed gap |
| --- | --- |
| Product page | Description, support URL and keywords absent; no screenshot sets or images |
| App information | Primary category and privacy-policy URL absent |
| Age rating | Questionnaire fields not completed |
| Version | No build selected; the draft version will need to match the chosen release build |
| Review access | Contact name/email/phone, review notes and demo-access details absent |

The subtitle and marketing URL are also absent but are not presented here as mandatory fields. App Privacy declarations, price, territories, agreements and account-specific legal requirements have **not** been fully inspected. Do not infer that an unqueried field is empty or complete.

A native `PrivacyInfo.xcprivacy` manifest is already shipped. That is separate from a public privacy policy, the in-app policy link and App Store Connect's privacy declarations. A targeted search did not find a user-facing policy entry in `client/src`, `web` or `docs`; implementation should be checked before adding one.

## Reviewers must not use the owner's production Mac

TaroBot needs a reachable Hub to exercise its main features. The recommended review setup is a **separate, controlled demo Hub** with test Bots, sample history/files and limited test credentials. It should be isolated from personal machines, production conversations, unrestricted file systems and production secrets. Provider usage, if needed, requires a bounded test budget and credentials rather than the owner's general-purpose keys.

Reviewers need a repeatable, documented way to connect without waiting for the owner to approve a new pairing request in real time. This means designing authorized review access to the isolated environment, not disabling pairing or granting access to the Mac mini. The environment should exercise the ordinary product behavior; do not create hidden review-only features or hide functionality from review.

No such environment has been deployed by this release. Its hosting location, cost and access policy remain decisions for a dedicated App Store preparation task.

## Work needed before submission

1. Finish the product description, category, screenshots, support page, age rating and release/version metadata. Explain clearly that the iOS App connects to a separately operated TaroBot Hub.
2. Map actual data flow across the iOS App, Hub, relay, push services and configured AI providers. Publish an accurate privacy policy, add an accessible App entry, and complete App Privacy declarations. Do not assume “self-hosted” means “no data collected.” Review disclosure/consent before personal data is shared with third-party AI.
3. Build and verify the isolated demo access described above. Document pairing/login, representative features, any required setup and how reviewers can obtain help. Verify this from outside the development network.
4. Audit the actual dynamic widget/HTML/plugin and remote-task behavior against Apple's current rules. Guidelines 2.5.2 and 4.7 may be relevant; applicability must be assessed from the real implementation rather than assuming a chatbot or remote client automatically passes or fails.
5. Decide distribution territories and price. For China mainland, check App ICP filing and any other requirements applicable to the actual service. This report does not conclude that every AI client requires the same additional licenses.
6. Select a processed build on the matching App Store version, complete the required review fields, add it for review, and submit only after the complete review package is approved by the owner. Resolve any Apple feedback before public release.

TestFlight `VALID / IN_BETA_TESTING` means the build is available to the assigned testers. It does not mean Apple has approved public App Store distribution, or that a physical iPhone installation has been verified.

## Official references checked

- [Submit an app](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app/)
- [Choose a build to submit](https://developer.apple.com/help/app-store-connect/manage-builds/choose-a-build-to-submit/)
- [App Review](https://developer.apple.com/app-store/review/)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — completeness, privacy, third-party AI, dynamic software
- [Manage App Privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
- [App Privacy details](https://developer.apple.com/app-store/app-privacy-details/)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- [China mainland filing and app information](https://developer.apple.com/cn/help/app-store-connect/reference/app-information/app-information/)

Private API snapshots and the sanitized readiness receipt are retained in the local release evidence directory. Account identifiers, contact information, credentials and signing material are not included in this report.
