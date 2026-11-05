# Command result cards

App command results previously arrived as text blocks. The Markdown renderer
collapsed their soft line breaks, including the Unicode bullets in `/usage`,
and the replies had no card container.

Gateway now sends command-helper results such as `/help`, `/model`, `/effort`
and `/usage` through the existing card protocol. Usage gets labeled metric
cells, a Bot-wide scope label, a readable UTC timestamp and a separate engine
limitation section. Empty usage has an explicit empty state. Unmetered requests
remain distinct from metered requests and do not produce invented zero-token
or zero-dollar metrics. Dollar totals are labeled as recorded costs; engines
without cost reporting retain their limitation notice even without a budget.
`/status` keeps its existing settings/resume actions and uses an App title.

The client also displays existing Bot text blocks in the same compact card body.
This covers historical command responses and brief receipts such as `/reset`,
without changing stored content or the source used by copy/forward. Card prose
already preserves authored paragraph line breaks while keeping Markdown lists,
code and tables intact. User text and existing interactive cards keep their
separate rendering paths. No new package, protocol version or migration is
required, and Feishu/Telegram text delivery stays separate.

## Verification scope

- `command-result-cards` checks empty, measured and unmetered ledgers, bilingual
  data fidelity, engine notes and channel-specific status titles.
- `gateway-command-parity` sends real command requests through a temporary Hub
  and Gateway and checks persisted card replies without invoking an engine.
- Browser `command-cards` uses the real command handler at 1360, 390 and 320px,
  including English, dark mode, historical text, reload, numeric values and
  overflow checks. The synthetic mixed ledger represents a Bot with earlier
  metered turns, then Kimi turns with no reported telemetry.
- `cards`, `command-parity`, `card-layout`, `markdown` and `message-reading`
  cover interactive actions, production card geometry, parsing and reading
  anchors. The standalone gallery fixtures now provide the current message
  author fields and attachment-action contract.

These are local fixture/browser checks, not physical phone acceptance. New
structured command responses need the updated Gateway; old text already gains
card typography in the updated client. This change does not publish a release,
replace the installed App or restart a running service.
