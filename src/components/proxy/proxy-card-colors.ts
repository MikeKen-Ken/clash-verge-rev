export const PROXY_CARD_BG = "#ffffff";
export const PROXY_CARD_HOVER_BG = "#f2f2f2";
export const PROXY_CARD_TEXT = "#1c1c1c";

/**
 * Android selected node fill: `color_clash_light` / `color_clash_dark`
 * in design/src/main/res/values/colors.xml. Text is `colorOnPrimary` (white).
 */
export const PROXY_CARD_SELECTED_BG_LIGHT = "#1e4376";
export const PROXY_CARD_SELECTED_HOVER_BG_LIGHT = "#27548f";
export const PROXY_CARD_SELECTED_BG_DARK = "#1976d2";
export const PROXY_CARD_SELECTED_HOVER_BG_DARK = "#1e88e5";
export const PROXY_CARD_SELECTED_TEXT = "#ffffff";

/** Android `Color.RED` for a timeout delay. A usable delay uses the card text color. */
export const PROXY_DELAY_TIMEOUT_COLOR = "#ff0000";

export function proxyCardSelectedBg(mode: string): string {
  return mode === "dark"
    ? PROXY_CARD_SELECTED_BG_DARK
    : PROXY_CARD_SELECTED_BG_LIGHT;
}

export function proxyCardSelectedHoverBg(mode: string): string {
  return mode === "dark"
    ? PROXY_CARD_SELECTED_HOVER_BG_DARK
    : PROXY_CARD_SELECTED_HOVER_BG_LIGHT;
}
