# Public Google integration: approved processing scope

The public Google integration is limited to reviewed cloud API configurations
or local inference. Google content must not be used to train general-purpose
models. This is a product requirement, not a claim that an allowlist or a public
connector has already shipped. Ordinary chat has a separate provider choice.

## Current implementation boundary

- `src/gdocs/` implements host-configured Google Docs authorization and export.
  Its private callback and OS credential storage do not control other tools.
- Gmail and Calendar access currently comes from independently configured tools
  such as Google Workspace CLI, invoked inside an engine process. There is no
  managed public Gmail/Calendar connector or shared public client binding here.
- `src/core/engine-factory.ts` delegates native tool execution to supported
  engines. A model display name does not establish the actual endpoint, account
  contract, retention settings or destination of tool results.
- The desktop [Google sign-in handoff](client/google-browser-handoff-2026-11-14.md)
  sends account pages to the system browser. It neither approves API access nor
  transfers that website login into the embedded browser.

Do not treat a host-side Google Docs export check, a disabled model-picker item,
a CLI-name blacklist or a prompt instruction as an enforcement boundary for
Google data processed by arbitrary native tools. A native tool may run gws,
invoke another client, read an existing file or reuse previously received data.

## Required controls before public rollout

1. Bind eligibility to the actual processor, API origin, organization/project,
   model and features, terms revision, data-sharing settings, retention and
   approved use. An unknown, expired or changed configuration is ineligible.
   A local URL alone does not prove local inference: verify remote fallback,
   telemetry, proxies, attachments and outbound tools too.
2. Put the public connector and its credentials behind a boundary that can
   enforce the selected destination before requesting data. Do not expose a
   public client through arbitrary engine tools and rely on their prompts to
   restrict where the result goes. Keep credentials out of model context.
3. Give a clear in-product disclosure of the selected processor, Google data
   categories, purpose and retention before consent. Record the accepted
   disclosure and processing configuration with the connection.
4. Preserve the restriction for Google-derived context, histories, summaries,
   attachments, retries, resumed sessions, scheduled tasks, side conversations,
   exports, browser reads and cross-Bot transfers. A model switch or fallback
   must not resend existing Google data to an unreviewed destination.
5. Ask only for the scopes used by the demonstrated feature. The actual OAuth
   request and console declaration must match. Do not include broad Cloud
   permissions merely because a development CLI previously requested them.
6. Provide independent revocation and retained-copy deletion controls. Logs and
   audits must not leak tokens or unnecessary Google content. Verify backups,
   connected devices, model-provider retention and prompt-injection boundaries.
7. Validate the actual public client, scopes, processor configuration and user
   flow using synthetic data. Record the real demonstration before submitting
   data-access verification; evaluate the applicable restricted-scope security
   assessment. Website ownership, brand approval and data-scope approval are
   distinct results.

These requirements apply to the shared host and headless CLI as well as the
App. A UI-only control is insufficient. They do not revoke existing user-owned
credentials or alter a self-hosted installation as a documentation side effect.

## Provider review notes

Reviewed official documentation on November 14, 2026. These are candidates for
account-specific review; none is automatically an approved configuration.

| Candidate | Review boundary |
| --- | --- |
| Local inference | Verify the complete data path stays local. Local execution still has Google data-use and retention obligations. |
| OpenAI API | Training is off by default unless sharing is enabled; abuse logs and application state have separate retention. Verify actual organization/project controls, endpoint and model features. `store: false` alone is not zero retention. |
| Anthropic commercial API | API data is not used for training without permission. ZDR has organization, model and feature limits; consumer subscriptions are outside that API arrangement. Verify the exact account and feature set. |
| Gemini paid API | Paid-service terms exclude content from product improvement but retain safety/security processing. Verify the actual billed project and feature terms; prohibit silent fallback to an unreviewed service. |

No-training is one requirement, not a complete Limited Use assessment. Review
the exact data use, transfers, retention and human-access exceptions. Do not
represent Zero Data Retention as a universal Google requirement or assume that
a provider's API terms apply to its consumer subscriptions or third-party proxy.

Sources:

- [Google Workspace user data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [Google verification and Limited Use FAQ](https://support.google.com/cloud/answer/13463817?hl=en)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Anthropic API retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- [Gemini API terms](https://ai.google.dev/gemini-api/terms)

## Acceptance boundary

This document records the chosen public-product scope and remaining engineering
requirements. It changes no runtime policy. A real provider organization and
complete public connector path have not been accepted. The data-access review
must remain unsubmitted until the materials accurately describe that tested
implementation. This work does not publish or install an App release.
