# Make the Bus name field discoverable

The configuration header previously used a borderless input styled as its
heading. Its placeholder looked like static title text, while the required-name
message appeared only in the small footer above the disabled Create button.

The header now displays the saved Bus name or **New collaboration**. The first
configuration field has an explicit **Bus name / Required** label, a persistent
border, a normal 40 px input and an example placeholder. Missing-name feedback
appears directly underneath and is connected through `aria-describedby`.
The feedback row reserves its height so typing does not shift the workflow.

The footer keeps the current reason for disabled creation, uses a readable
12 px font and theme-accent color for invalid configuration, and describes the
Create/Save button for assistive technology. Validating, saving, renaming,
permissions and execution still use the existing rules; saving never starts a
task. This is desktop presentation only, with no host or headless CLI change.

Focused browser checks cover empty/whitespace names, visible input affordances,
nearby feedback, enabled creation after valid fields, saved-workspace editing,
reload/dirty-draft retention and the previous Bus-return scrollbar regression.
The appearance matrix includes light and dark violet themes and dark CLI at
1440/1024 px. Browser checks use isolated Hubs and controlled Bus API responses;
they do not establish native installation or real-agent execution acceptance.
No App release or local Mac replacement is included in this change.

Validation on 2026-10-18: all six focused scenarios passed in both Chromium
and WebKit (12 checks total). The client production build, including translation
and TypeScript checks, passed. Actual rendered panels were inspected in the
light violet and dark CLI themes.
