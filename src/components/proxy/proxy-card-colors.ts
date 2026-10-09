export const PROXY_CARD_BG = "#ffffff";
export const PROXY_CARD_HOVER_BG = "#f2f2f2";
export const PROXY_CARD_TEXT = "#1c1c1c";

export const PROXY_CARD_SELECTED_BG = "#000000";
export const PROXY_CARD_SELECTED_HOVER_BG = "#1c1c1c";
export const PROXY_CARD_SELECTED_TEXT = "#ffffff";

/** Delay colours that stay readable on both the white and the black card. */
export function proxyDelayToneColor(
  tone: "success" | "error",
  selected: boolean,
): string {
  if (tone === "error") return selected ? "#ff6b6b" : "#c62828";
  return selected ? "#69db7c" : "#2e7d32";
}
