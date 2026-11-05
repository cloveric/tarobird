# Working avatar motion — 2026-10-31

The owner found that the working hop read like completion, because the done state
also jumps. After reviewing demo videos of six alternatives, a head-sway speed
comparison and a typing-bubble speed comparison, the owner chose:

- a slow head sway, one left-right cycle per 4.2 s, that never leaves the ground;
- eyes that read line by line, three lines per 12.6 s, with a blink every 8.4 s
  when the picture has a detected face;
- a typing bubble above the avatar's right ear, with three dots taking turns,
  one round per 1.6 s.

This replaces the "two small hops" row for Working in
[list avatar states](avatar-agent-state-2026-10-30.md). Completion, failure and
the needs-you state are unchanged. On phone rows that show an unread count in the
top-right corner, the bubble mirrors to the top-left. With the animated-avatar
setting off, neither the sway nor the bubble is shown. Bubble colours use
`--raised`, `--border` and `--muted`, so it follows light and dark palettes.

Presentation only; Host protocol and headless CLI are unchanged.

## Verification

`client/e2e/avatar-agent-state.spec.ts` passed 5 cases in Chromium and 5 in WebKit.
It checks the sway animation, three typing dots while working, no bubble when the
setting is off and no bubble after completion. Real-client captures covered the
desktop sidebar and a 390px phone list. Browser evidence is not physical-device
acceptance.
