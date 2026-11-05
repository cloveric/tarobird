# GitHub homepage and linked-guide audit — 2026-10-17

Scope: the bilingual homepage, its English pointer, screenshot presentation and
the directly linked installation, product, CLI and cross-host messaging guides.
The baseline is `0002b07677423ab057e7cb37f57f9c8f427bea56`. This is not a new
whole-product security audit or native installer acceptance run.

The primary agent checked current source, published GitHub Release assets and
rendered Markdown. A separate local Claude Code invocation used
`claude-opus-5-5[1m]` with `--effort xhigh`, read-only Read/Glob/Grep tools and no
external MCP servers. Its initial findings were checked against source before
adoption; model review is not test or device evidence.

A second invocation with the same model and effort reviewed the resulting diff
and reported no blocking findings. It found one remaining ambiguous recovery
sentence in the CLI guide; the final text now separately names the message ID
used by `wait` and the request ID used to recover an uncertain `send`.

## Confirmed corrections

| Area | Correction |
| --- | --- |
| Prominent phone UI | Keep desktop, phone inbox and phone chat together outside disclosure blocks. Use existing raw captures instead of framed compositions so controls get more space; phone images retain their aspect ratio and wrap on narrow pages. |
| Screenshot freshness | State the 1.0.49 capture version and 2026-10-13 date, link provenance, and remove the claim that old captures show the current UI. No screenshot pixels were altered or represented as fresh native captures. |
| Installation path | Replace the CLI guide's obsolete 0.1.425 filename/tag with the verified 0.1.430 archive; distinguish installing that archive from building a standalone package. |
| Windows download | Remove the known affected 1.0.76 candidate from the recommended install path; retain its historical release link and point to the native startup repair. A fixed installer is still pending. |
| Source versus package | Explain that published 0.1.430 uses schema 16 while current source with the same version string uses schema 17. Link the upgrade process and keep development data separate. |
| Bot handoff prerequisites | Show target-host owner authorization, the scope of the grant, and the absence of an App grant screen. Distinguish ordinary chat requests to a Bot from the commands the Bot executes. |
| Sender identity and recovery | Specify `--source-bot` on all three operator commands, current-turn `--context-message` for Bot sends, unique task IDs, permitted file paths and reply output. Separate `wait` timeout recovery from uncertain `send` recovery. |
| CLI help | Add the already-supported source-Bot option to send/wait help. No parser, authorization or delivery behavior changes. |
| Product-guide drift | Correct obsolete source-only/TaroCub/Lark-SDK statements, link-preview selection, schedule management, Skills/MCP assistance, backup commands and cross-host verification scope. Add personal deletion scope. |
| Navigation and examples | Add CLI/cross-host/download entries, route status links to current platform evidence, mark Chinese guides and historical audits, and use a Claude model for the Claude Bot example. |
| English UI wording | Change the group count label from `1 topics` to count labels that work for any quantity. This is a translation-only source correction, not an installed-App update. |
| Verification wording | Consistently report 4,134 passed and one skipped for the earlier full regression; do not imply Windows ran the full suite. |

## Checks for this revision

- Two focused suites (`host-cli-entry` and `host-cli-bot-messages`): 14 tests passed.
- Source CLI `--help`: list/send/wait all expose the source-Bot option.
- UI translation keys and placeholders: passed.
- Twelve changed Markdown files: 322 relative links and heading anchors checked,
  with no missing destinations; fenced code blocks balanced.
- GitHub Markdown API: both homepages and the product guide rendered. Parsed
  output confirms the desktop/inbox/chat images are adjacent, outside `details`,
  with descriptive alt text and widths of 100% / 360 / 360.
- Release API: Mac 1.0.80 / CLI 0.1.430 and Android 1.0.82 filenames match actual
  assets under `v0.1.430-test.1` and `v0.1.430-test.3`.
- `git diff --check`: passed.

The existing full regression and physical Mac/Windows messaging receipts remain
historical feature evidence; they were not rerun for documentation and text
changes. No App, CLI archive, host state, credentials or running service was
replaced. The earlier cloud checks were blocked before execution by GitHub
account billing/limits; local checks are not cloud CI success.

## Remaining boundaries

Fresh screenshots of the latest client remain a separate capture task; the
dated demonstration images are retained transparently. New cross-host packages
and the corrected Windows installer still require their release and device gates.
Optional extra diagrams or themes are presentation suggestions, not unresolved
functional defects in this homepage change.
