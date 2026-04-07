import type { ChatEventPayload } from "./controllers/chat.ts";

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  // Always reload history on final events to pick up inbound messages
  // from other channels (e.g. Telegram) that the web UI hasn't seen.
  return true;
}
