# System Smoothness & Zero-Lag UX Optimization (Orca Benchmark, 2026-11-26)

Refs #82

## Scope & Measurement Boundary

This document records the architecture audit against the MIT-licensed [Orca](https://github.com/nicbarker/orca) reference tree (`app-keyboard-router.ts`, `useSidebarResize.ts`, `NativeChatMessageList.tsx`, `NativeChatMessageRow.tsx`) and reproducible headless Chromium + real `HubServer` before/after measurements on macOS for TaroBird `client/dist`.

**Explicit boundary**:
- Benchmarks below were measured on macOS headless Chromium (`Playwright`) connected directly to an in-process `HubServer` serving built `client/dist`.
- Electron main/renderer cold startup and Windows Host (`BrowserWindow` resize / native shell overhead) were **not** separately benchmarked in this pass.

---

## Root Causes Identified vs. Orca

1. **Uncached conversation switches (`client/src/storage.ts`, `client/src/conversation-messages.ts`)**:
   - Every conversation switch cleared `current` to an empty array and waited for an asynchronous IndexedDB `getAllFromIndex("messages", "conversation", conversationId)` read + sort, causing 1–2 visible blank frames on every switch (`38.9–51.6ms` first content, 7 blank frames across 6 warm switches).
2. **Proliferating global `document`/`window` listeners (`client/src/`)**:
   - Independent modules and hooks (`DesktopMenu`, `Content`, `PreferencesPanel`, `Sidebar`, `HostApp`, `App`, `motion`, `message-action-hover`, `useMessageHold`, `useConversationHold`, `focus-intent`, `ShareInbox`, `ComposerSuggestions`, `connection`, `local-day`, `use-diff-review`, `GroupDiscussionBar`) each attached their own global listeners (`38–40` document listeners and `51` window listeners in idle/menu states).
   - Orca pools global DOM listeners into shared dispatchers (`app-keyboard-router.ts`) with a single listener per `(target, eventType, capture)`.
3. **Unmemoized message rows, per-row context providers, and sidebar O(N^2) passes (`client/src/App.tsx`, `client/src/ConversationList.tsx`)**:
   - Virtualized message items rendered inline JSX with per-row `<TurnStopContext.Provider>` / `<MessageOverlayContext.Provider>` wrappers, causing unchanged rows to re-render when typing or streaming one chunk.
   - `ConversationList` performed repeated linear scans (`bots.find`, `conversations.find`, `includes`) across every row per render without `React.memo` or pre-indexed maps/sets.
4. **Un-coalesced pointer drag & resize observers (`client/src/Sidebar.tsx`, `client/src/HostApp.tsx`, `client/src/styles.css`)**:
   - Sidebar drag `onPointerMove` and `ResizeObserver` callbacks triggered synchronous state/DOM updates on every event without `requestAnimationFrame` coalescing or layout containment (`contain: layout style`), causing dropped frames (`33.4ms` max frame time during drag + viewport resize).
5. **Conservative remote route switch hysteresis (`client/src/route-performance.ts`)**:
   - `RoutePerformance.shouldSwitch` previously required `max(50ms, active * 0.3)` improvement; aligned to Orca's `max(25ms, active * 0.2)` hysteresis to switch faster to meaningfully healthier routes without flapping.

---

## Implemented Changes

All changes are original TaroBird implementations inspired by Orca's architectural patterns (zero upstream files or code copied):

- **`client/src/global-event-hub.ts`**: Pooled `addGlobalListener`, `subscribeMediaQuery`, and `getGlobalListenerStats` sharing one native listener per `(target, type, capture)` tuple and migrating listeners across 17 client modules/components.
- **`client/src/message-lru-cache.ts` + `client/src/storage.ts` + `client/src/conversation-messages.ts`**:
  - Bounded `ConversationMessageCache` (16 conversations, 12,000 messages) wired into `ClientStore` (`peekMessages`, cache hit/miss in `messages()` with epoch fencing, live patches in `apply()`, invalidation on `acceptSnapshot`/`forgetIdentity`/`close`, and cross-tab `BroadcastChannel` sync).
  - Synchronous `peekMessages` seeding inside `useConversationMessages` for 0-blank-frame warm switches plus `WeakMap`-cached deleted-message filtering and no-op `setView` skip on unchanged snapshots.
- **`client/src/WorkspaceMessageRow.tsx` + `client/src/App.tsx` + `client/src/ConversationList.tsx` + `client/src/styles.css`**:
  - Extracted memoized `WorkspaceMessageRow` (`memo`), hoisted `TurnStopContext.Provider` / `MessageOverlayContext.Provider` outside the message `.map()`, pre-indexed `botsById` / `conversationIdSet`, and stabilized sidebar callbacks/props.
  - Wrapped `ConversationList` in `memo` with `useMemo`-indexed lookups and added CSS `contain: layout style` to `.conversation-row` and `.message`.
- **`client/src/Sidebar.tsx` + `client/src/HostApp.tsx`**:
  - Coalesced sidebar pointer drag moves, sidebar `ResizeObserver`, and board window `resize` updates via `requestAnimationFrame` with identical-width/dimension guards.
- **`client/src/route-performance.ts`**:
  - Updated hysteresis threshold to `Math.max(25, active * 0.2)`.

---

## Reproducible Benchmark Results (Before vs. After)

Seeded state per run (`HubServer` + headless Chromium `1280x800`):
- 2 bots (`codex`, `claude`), 30 conversations (2 long threads with 1,500 Markdown/code messages each, 1 streaming thread with 200 messages, 27 sidebar conversations).
- Script measures: listener counts (idle & menu open), cold switch + 6 warm A<->B switches on 1,500-message threads, 50-step scroll on 1,500-message thread, 30 keystrokes during 50ms bot streaming intervals, and sidebar drag + 3 viewport resizes.

| Metric | Baseline (`origin/main`) | Optimized | Delta |
|---|---:|---:|---|
| Document listeners (idle) | `38` | `27` | `-11` (`-28.9%`) |
| Document listeners (menu open) | `40` | `28` | `-12` (`-30.0%`) |
| Window listeners (idle / menu) | `51` | `45` | `-6` (`-11.8%`) |
| Warm switch blank frames (6 switches total) | `7` | `0` | **`-100%` (0 blank frames)** |
| Warm switch first content (`p50` / `max` / `avg`) | `39.5ms` / `51.6ms` / `41.17ms` | `17.9ms` / `26.8ms` / `19.18ms` | **`-54.7%` p50 / `-48.1%` max** |
| Warm switch settled (`p50` / `max` / `avg`) | `47.7ms` / `63.6ms` / `50.45ms` | `29.2ms` / `31.7ms` / `29.48ms` | **`-38.8%` p50 / `-50.2%` max** |
| Cold switch first content / blank frames | `38.9ms` / `2` | `41.4ms` / `2` | ~equal (expected on cold IDB read) |
| Long scroll 1,500 msgs (`p50` / `max` / `>50ms`) | `16.7ms` / `16.8ms` / `0` | `16.7ms` / `16.8ms` / `0` | Smooth `~60fps` ceiling |
| Typing during 50ms stream (`>16ms` frames / `>50ms`) | `14` of `30` / `0` | `9` of `30` / `0` | `-35.7%` frames `>16.7ms` |
| Typing keystroke latency (`p50` / `max`) | `16.63ms` / `18.83ms` | `16.67ms` / `21.74ms` | Both single-frame interactive, `0` long tasks |
| Sidebar drag + resize max frame time | `33.4ms` (`avg 17.13ms`) | `16.8ms` (`avg 16.67ms`) | **`-49.7%` max frame (no dropped drag frame)** |
