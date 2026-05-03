/**
 * Single source of truth for `user.is_bot`. Used by the embed phase (#11) to
 * skip bot-authored content per the "Bots are ingested but not embedded"
 * principle in ARCHITECTURE.md.
 *
 * Rule:
 *   - GraphQL author with __typename === "Bot"  → bot
 *   - login ending in "[bot]"                   → bot
 *   - everything else                           → not bot
 *
 * Manual overrides (`is_bot_override`) and known-bot allowlists (e.g.
 * `mergify-bot`, `codecov-commenter`) are deliberately not implemented;
 * defer-until-it-hurts. Revisit when a real case demands it.
 */
export function isBot(
  typename: "User" | "Bot",
  login: string,
): boolean {
  return typename === "Bot" || login.endsWith("[bot]");
}
