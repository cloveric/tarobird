import assert from "node:assert/strict";
import { it } from "vitest";
import { isUnavailableCardAction, outboxFailureBlocks, UNAVAILABLE_CARD_ACTION } from "../client/src/outbox-failure.js";

it("only a definitively rejected card action is nonblocking", () => {
  for (const type of ["interaction.submit", "message.send", "message.forward", "conversation.create"]) {
    const entry = { frame: { type }, error: UNAVAILABLE_CARD_ACTION };
    assert.equal(isUnavailableCardAction(entry), type === "interaction.submit");
    assert.equal(outboxFailureBlocks(entry), type !== "interaction.submit");
  }
});

it("uncertain delivery, other errors and permission failures retain FIFO", () => {
  for (const error of ["interaction_forbidden", "interaction_expired", "attachment_unavailable", "temporary_storage_error", "action_unavailable ", "uncertain delivery"]) {
    const entry = { frame: { type: "interaction.submit" }, error };
    assert.equal(isUnavailableCardAction(entry), false);
    assert.equal(outboxFailureBlocks(entry), true);
  }
});

it("an unfailed card request is still deliverable", () => {
  const entry = { frame: { type: "interaction.submit" } };
  assert.equal(isUnavailableCardAction(entry), false);
  assert.equal(outboxFailureBlocks(entry), false);
});
