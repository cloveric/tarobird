# Consistent message body size

Mac 1.0.54 removes the extra pixel applied to direct message Markdown. User
messages used that rule, while both plain Bot text and structured replies used
card typography at the chosen reading size. For example, a 16px preference
rendered user prose at 17px and Bot prose at 16px. Both now use the preference
without an offset; metadata, headings and theme-specific fonts keep their roles.

The existing font-preference browser regression now compares identical Chinese,
English and numeric prose in a user message, a plain Bot reply and a reply card.
It checks size, family and normal weight at 12/14/16/20px across CLI, pixel and
monochrome themes, with chat navigation and reload at 390px and 1360px widths.
The added assertion failed against the old bundle (expected 16px, received 17px).

Chromium passed all five typography/font-preference cases; WebKit passed the
four applicable cases. These include the existing CLI table/code size, bilingual
font and contrast checks. Root and client builds passed. Rendered desktop and
phone-size screenshots were inspected. These browser checks do not substitute
for a physical-device test. The local Apple Silicon DMG is version 1.0.54;
the installed App and running host are not replaced by packaging it.
