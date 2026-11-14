# Compatibility widget delivery

Antigravity and Kimi can publish an inline visual through the App's existing
`send.widget` compatibility command. A Markdown fence labelled `send` is ordinary
text. A completed model response, or a successful delivery of that text, is not
evidence that a widget was published.

The standing instructions previously named the three widget fields without the
required outer `name`/`payload` object. Ordinary requests such as “画个图” also
missed the detailed authoring guide. Together, these omissions left compatibility
engines without a complete example on a common drawing turn.

The standing guidance now includes an executable example:

````markdown
```tool-call
{"name":"send.widget","payload":{"title":"Title","summary":"Summary","html":"<section>...</section>"}}
```
````

The same example is shared with on-demand widget guidance. Generic drawing,
structure and architecture-diagram requests now select that guidance. Existing
implementation-discussion exclusions, HTML-first policy and explicit structured
report selection remain. The compatibility standing-instruction budget grows by 100 characters for the
complete envelope while retaining the theme, narrow-width and focus constraints.
Native-widget instruction budgets and contracts are unchanged. Drawing-software
questions, questions about existing diagrams, and picture-generation requests do
not select the additional diagram recipe.

This change does not make `send`, `send.widget`, `html` or `json` Markdown fences
executable. Quoted examples and examples nested in code remain text. It does not
add a text-based retry loop: a model may already have published through a native
tool or the CLI, and an automatic retry without receipt reconciliation could
duplicate that publication. Native tool schemas, saved contracts, rendering,
attachment upload and mobile layout are unchanged.

The delivery error path now distinguishes malformed command JSON from a
`SyntaxError` raised later by widget script validation. Execution failures are
recorded in the tool timeline. App widget failures have English/Chinese feedback
that asks the Bot to check content and delivery status before retrying; raw HTML
and exception details are not exposed in that notice. A transport failure does
not prove the remote publication failed, so this path does not replay the widget.

## Verification

- The added instruction regressions failed on the original source for both
  affected engines, then passed with the complete envelope and drawing route.
- A fence extracted directly from each engine's generated instructions reaches
  the compatibility delivery path once, without leaking the directive as text.
- Plain `send`/`send.widget`/`html`/`json` examples, quoted tool calls and enclosing
  Markdown fences remain text and do not publish widgets.
- Real Antigravity and Kimi responses to a synthetic diagram request each yielded
  one valid widget through the core parser and real widget validator. The sink
  was an isolated synthetic channel, not an installed App. Additional probes
  without the detailed recipe produced one valid widget from each engine when
  requesting a visual component. A generic Kimi request instead returned a text
  diagram; the short instructions do not force every explanatory reply to become
  a widget.
- Related coverage includes the publication switch, native contract hashes,
  instruction length, English requests, implementation discussions, Gateway
  delivery and the existing artifact follow-up logic.

These checks establish source/protocol behavior. They do not establish physical
Android/iOS or installed-App acceptance. Existing malformed messages remain
readable; updating the Host does not retroactively execute old code blocks.
