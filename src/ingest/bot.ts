// STUB: refined by #9. Stable signature.
export function isBot(typename: "User" | "Bot", login: string): boolean {
  return typename === "Bot" || login.endsWith("[bot]");
}
