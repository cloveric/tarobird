/** Stable Hub rejection: this particular card action is absent or disabled. */
export const UNAVAILABLE_CARD_ACTION = "action_unavailable";
type Failure = { frame: { type: string }; error?: string };

/** Also recognizes failed actions persisted by older clients; no data migration. */
export function isUnavailableCardAction(entry: Failure): boolean {
  return entry.frame.type === "interaction.submit" && entry.error === UNAVAILABLE_CARD_ACTION;
}

/** An explicitly rejected, obsolete action cannot become valid by waiting. */
export function outboxFailureBlocks(entry: Failure): boolean {
  return !!entry.error && !isUnavailableCardAction(entry);
}
