# Excel attachment reading and external apps

Phone and desktop attachment previews now read `.xlsx`, `.xlsm` and legacy
compound `.xls` files locally. The same reader handles sent/received files,
conversation files, and unsent draft attachments. Sheet tabs, fixed column/row
headers, horizontal scrolling and 100-row/26-column pages support narrow screens.
Dates, numeric formats, merged headings and cached formula values are retained.
This is a read-only content preview; charts, embedded objects and full Excel
styling are not rendered, and formulas/macros/external links are never executed.
A formula without a saved result is shown as a formula with an explicit note.

SheetJS CE 0.20.3 is pinned with a lockfile integrity digest from the
[official distribution](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/).
The parser is bundled locally and loaded only inside a disposable worker when
opening a spreadsheet. No CDN or online conversion service is used at runtime.
The existing Word ZIP boundary also protects OOXML spreadsheet inflation: 10 MiB
input, 16 MiB per inflated entry, 32 MiB total, 2,000 entries, duplicate/path
checks and reconstruction of validated bytes. A 20-second watchdog terminates
work; closing the modal releases it. Previews show up to 5,000 rows/200 columns
and 100 sheets, with explicit limits and unchanged original-file export.

Native mobile previews add **用其他应用打开**. Android prepares a private cached
copy and uses an ACTION_VIEW chooser with an extension-derived MIME type and a
single read-only content URI. The dedicated FileProvider only exposes prepared
exports; canonical path checks reject directories, traversal and escaping
symlinks. No Hub URL or authentication token is handed to the receiver. Missing
readers produce an actionable error. The UI reports opening the picker, not a
confirmed save or proof that a recipient read the file. iOS uses its document
share sheet. Existing **另存为** remains available. Copies are retained for delayed
receivers and swept after 24 hours on a later export; failed preparation/open
removes its own copy.

Regression coverage: `client-spreadsheet`, `client-docx-archive`, browser
`spreadsheet-preview`, `document-preview`, `attachment-safety`, `desktop-export`,
`mobile-file-export`; Android `AttachmentOpenPolicyTest` and isolated
`AttachmentOpenTest`. Browser/native results and physical-device acceptance
must be reported separately. The native probe is a separate test APK/UID and
checks exact bytes plus read-only access through the actual WebView plugin.
