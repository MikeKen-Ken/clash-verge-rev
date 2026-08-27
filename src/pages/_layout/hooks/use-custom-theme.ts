import { alpha, createTheme, Theme as MuiTheme, Shadows } from "@mui/material";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { Theme as TauriOsTheme } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";

import { useVerge } from "@/hooks/use-verge";
import { defaultDarkTheme, defaultTheme } from "@/pages/_theme";
import { useSetThemeMode, useThemeMode } from "@/services/states";

const CSS_INJECTION_SCOPE_ROOT = "[data-css-injection-root]";
const CSS_INJECTION_SCOPE_LIMIT =
  ':is(.monaco-editor .view-lines, .monaco-editor .view-line, .monaco-editor .margin, .monaco-editor .margin-view-overlays, .monaco-editor .view-overlays, .monaco-editor [class^="mtk"], .monaco-editor [class*=" mtk"])';
const TOP_LEVEL_AT_RULES = [
  "@charset",
  "@import",
  "@namespace",
  "@font-face",
  "@keyframes",
  "@counter-style",
  "@page",
  "@property",
  "@font-feature-values",
  "@color-profile",
];
let cssScopeSupport: boolean | null = null;

const REMOTE_BACKGROUND = /^(url\(|https?:|data:|blob:|asset:)/i;

const toBackgroundImageCss = (source: string): string => {
  const trimmed = source.trim();
  if (!trimmed) return "none";
  if (REMOTE_BACKGROUND.test(trimmed)) {
    return trimmed.startsWith("url(")
      ? trimmed
      : `url("${trimmed.replace(/"/g, "%22")}")`;
  }
  try {
    return `url("${convertFileSrc(trimmed).replace(/"/g, "%22")}")`;
  } catch {
    return `url("${trimmed.replace(/"/g, "%22")}")`;
  }
};

const canUseCssScope = () => {
  if (cssScopeSupport !== null) {
    return cssScopeSupport;
  }
  try {
    const testStyle = document.createElement("style");
    testStyle.textContent = "@scope (:root) { }";
    document.head.appendChild(testStyle);
    cssScopeSupport = !!testStyle.sheet?.cssRules?.length;
    document.head.removeChild(testStyle);
  } catch {
    cssScopeSupport = false;
  }
  return cssScopeSupport;
};

const wrapCssInjectionWithScope = (css?: string) => {
  if (!css?.trim()) {
    return "";
  }
  const lowerCss = css.toLowerCase();
  const hasTopLevelOnlyRule = TOP_LEVEL_AT_RULES.some((rule) =>
    lowerCss.includes(rule),
  );
  if (hasTopLevelOnlyRule) {
    return null;
  }
  const scopeRoot = CSS_INJECTION_SCOPE_ROOT;
  const scopeLimit = CSS_INJECTION_SCOPE_LIMIT;
  const scopedBlock = `@scope (${scopeRoot}) to (${scopeLimit}) {
${css}
}`;
  return scopedBlock;
};

/**
 * custom theme
 */
export const useCustomTheme = () => {
  const appWindow: WebviewWindow = useMemo(() => getCurrentWebviewWindow(), []);
  const { verge } = useVerge();
  const { theme_mode, theme_setting } = verge ?? {};
  const mode = useThemeMode();
  const setMode = useSetThemeMode();
  const wallpaperList = useMemo(() => {
    const images = (theme_setting?.background_images ?? []).filter(Boolean);
    if (images.length > 0) return images;
    return theme_setting?.background_image ? [theme_setting.background_image] : [];
  }, [theme_setting?.background_image, theme_setting?.background_images]);
  const [activeWallpaper, setActiveWallpaper] = useState(
    () => wallpaperList[0] || "",
  );

  useEffect(() => {
    if (activeWallpaper && wallpaperList.includes(activeWallpaper)) return;
    setActiveWallpaper(wallpaperList[0] || "");
  }, [activeWallpaper, wallpaperList]);

  useEffect(() => {
    if (
      theme_setting?.background_playback !== "random" ||
      wallpaperList.length < 2
    ) {
      return;
    }
    const intervalMs =
      Math.max(30, theme_setting.background_interval_seconds || 300) * 1000;
    const timer = window.setInterval(() => {
      setActiveWallpaper((prev) => {
        if (wallpaperList.length < 2) return prev;
        let next = prev;
        let guard = 0;
        while (next === prev && guard < 8) {
          next = wallpaperList[Math.floor(Math.random() * wallpaperList.length)];
          guard += 1;
        }
        return next;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [
    theme_setting?.background_interval_seconds,
    theme_setting?.background_playback,
    wallpaperList,
  ]);

  const userBackgroundImage = activeWallpaper || wallpaperList[0] || "";
  const hasUserBackground = wallpaperList.length > 0;

  useEffect(() => {
    if (theme_mode === "light" || theme_mode === "dark") {
      setMode(theme_mode);
    }
  }, [theme_mode, setMode]);

  useEffect(() => {
    if (theme_mode !== "system") {
      return;
    }

    let isMounted = true;

    const timerId = setTimeout(() => {
      if (!isMounted) return;
      appWindow
        .theme()
        .then((systemTheme) => {
          if (isMounted && systemTheme) {
            setMode(systemTheme);
          }
        })
        .catch((err) => {
          console.error("Failed to get initial system theme:", err);
        });
    }, 0);

    const unlistenPromise = appWindow.onThemeChanged(({ payload }) => {
      if (isMounted) {
        setMode(payload);
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(timerId);
      unlistenPromise
        .then((unlistenFn) => {
          if (typeof unlistenFn === "function") {
            unlistenFn();
          }
        })
        .catch((err) => {
          console.error("Failed to unlisten from theme changes:", err);
        });
    };
  }, [theme_mode, appWindow, setMode]);

  useEffect(() => {
    if (theme_mode === undefined) {
      return;
    }

    if (theme_mode === "system") {
      appWindow.setTheme(null).catch((err) => {
        console.error(
          "Failed to set window theme to follow system (setTheme(null)):",
          err,
        );
      });
    } else if (mode) {
      appWindow.setTheme(mode as TauriOsTheme).catch((err) => {
        console.error(`Failed to set window theme to ${mode}:`, err);
      });
    }
  }, [mode, appWindow, theme_mode]);

  const theme = useMemo(() => {
    const setting = theme_setting || {};
    const dt = mode === "light" ? defaultTheme : defaultDarkTheme;
    let muiTheme: MuiTheme;

    try {
      muiTheme = createTheme({
        breakpoints: {
          values: { xs: 0, sm: 650, md: 900, lg: 1200, xl: 1536 },
        },
        palette: {
          mode,
          primary: { main: setting.primary_color || dt.primary_color },
          secondary: { main: setting.secondary_color || dt.secondary_color },
          info: { main: setting.info_color || dt.info_color },
          error: { main: setting.error_color || dt.error_color },
          warning: { main: setting.warning_color || dt.warning_color },
          success: { main: setting.success_color || dt.success_color },
          text: {
            primary: hasUserBackground
              ? "#1c1c1c"
              : setting.primary_text || dt.primary_text,
            secondary: hasUserBackground
              ? "rgba(28, 28, 28, 0.72)"
              : setting.secondary_text || dt.secondary_text,
          },
          background: {
            paper: dt.background_color,
            default: dt.background_color,
          },
        },
        shadows: Array(25).fill("none") as Shadows,
        typography: {
          fontFamily: setting.font_family
            ? `${setting.font_family}, ${dt.font_family}`
            : dt.font_family,
        },
      });
    } catch (e) {
      console.error("Error creating MUI theme, falling back to defaults:", e);
      muiTheme = createTheme({
        breakpoints: {
          values: { xs: 0, sm: 650, md: 900, lg: 1200, xl: 1536 },
        },
        palette: {
          mode,
          primary: { main: dt.primary_color },
          secondary: { main: dt.secondary_color },
          info: { main: dt.info_color },
          error: { main: dt.error_color },
          warning: { main: dt.warning_color },
          success: { main: dt.success_color },
          text: {
            primary: hasUserBackground ? "#1c1c1c" : dt.primary_text,
            secondary: hasUserBackground
              ? "rgba(28, 28, 28, 0.72)"
              : dt.secondary_text,
          },
          background: {
            paper: dt.background_color,
            default: dt.background_color,
          },
        },
        typography: { fontFamily: dt.font_family },
      });
    }

    const rootEle = document.documentElement;
    if (rootEle) {
      const backgroundColor =
        mode === "light" ? "#ECECEC" : dt.background_color;
      const selectColor = mode === "light" ? "#f5f5f5" : "#3E3E3E";
      const scrollColor = mode === "light" ? "#90939980" : "#555555";
      const dividerColor =
        mode === "light" ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.06)";
      rootEle.style.setProperty("--divider-color", dividerColor);
      rootEle.style.setProperty("--background-color", backgroundColor);
      rootEle.style.setProperty("--selection-color", selectColor);
      rootEle.style.setProperty("--scroller-color", scrollColor);
      rootEle.style.setProperty(
        "--primary-main",
        muiTheme.palette.primary.main,
      );
      rootEle.style.setProperty(
        "--background-color-alpha",
        alpha(muiTheme.palette.primary.main, 0.1),
      );
      rootEle.style.setProperty(
        "--window-border-color",
        mode === "light" ? "#cccccc" : "#1E1E1E",
      );
      rootEle.style.setProperty(
        "--scrollbar-bg",
        mode === "light" ? "#f1f1f1" : "#2E303D",
      );
      rootEle.style.setProperty(
        "--scrollbar-thumb",
        mode === "light" ? "#c1c1c1" : "#555555",
      );
      rootEle.style.setProperty(
        "--user-background-image",
        hasUserBackground ? toBackgroundImageCss(userBackgroundImage) : "none",
      );
      rootEle.style.setProperty(
        "--background-blend-mode",
        setting.background_blend_mode || "normal",
      );
      rootEle.style.setProperty(
        "--background-opacity",
        setting.background_opacity !== undefined
          ? String(setting.background_opacity)
          : "1",
      );
      rootEle.setAttribute("data-css-injection-root", "true");
      rootEle.setAttribute("data-theme-mode", mode === "light" ? "light" : "dark");
      if (hasUserBackground) {
        rootEle.setAttribute("data-liquid-glass", "1");
      } else {
        rootEle.removeAttribute("data-liquid-glass");
      }
    }

    let styleElement = document.querySelector("style#verge-theme");
    if (!styleElement) {
      styleElement = document.createElement("style");
      styleElement.id = "verge-theme";
      document.head.appendChild(styleElement!);
    }

    if (styleElement) {
      let scopedCss: string | null = null;
      if (canUseCssScope() && setting.css_injection) {
        scopedCss = wrapCssInjectionWithScope(setting.css_injection);
      }
      const effectiveInjectedCss = scopedCss ?? setting.css_injection ?? "";
      const globalStyles = `
        /* 修复滚动条样式 */
        ::-webkit-scrollbar {
          width: 8px;
          height: 8px;
          background-color: var(--scrollbar-bg);
        }
        ::-webkit-scrollbar-thumb {
          background-color: var(--scrollbar-thumb);
          border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background-color: ${mode === "light" ? "#a1a1a1" : "#666666"};
        }

        /* 背景图由 html[data-liquid-glass] 的固定层绘制，避免把整页 opacity 套到 UI 上 */
        body {
          background-color: ${hasUserBackground ? "transparent" : "var(--background-color)"};
        }

        /* 修复可能的白色边框 */
        .MuiPaper-root {
          border-color: ${hasUserBackground
          ? "var(--glass-edge)"
          : "var(--window-border-color)"} !important;
        }

        /* 液态玻璃开启时对话框走磨砂层，否则保持实色主题 */
        .MuiDialog-paper {
          background-color: ${hasUserBackground
          ? "transparent"
          : mode === "light"
            ? "#ffffff"
            : "#2E303D"} !important;
        }

        /* 去掉布局层杂散描边，但保留菜单/弹出层阴影 */
        .layout,
        .base-page,
        .base-container {
          outline: none !important;
          box-shadow: none !important;
        }
      `;

      styleElement.innerHTML = effectiveInjectedCss + globalStyles;
    }

    return muiTheme;
  }, [mode, theme_setting, userBackgroundImage, hasUserBackground]);

  // 渐变色 DOM 注入：原本写在 useMemo 内的 setTimeout 没有清理，
  // 主题频繁切换/重算时会堆积回调，且可能在卸载后仍写 DOM。
  // 拆到独立 useEffect 并在 cleanup 中 clearTimeout。
  useEffect(() => {
    const { palette } = theme;
    const timerId = setTimeout(() => {
      const dom = document.querySelector("#Gradient2");
      if (dom) {
        dom.innerHTML = `
        <stop offset="0%" stop-color="${palette.primary.main}" />
        <stop offset="80%" stop-color="${palette.primary.dark}" />
        <stop offset="100%" stop-color="${palette.primary.dark}" />
        `;
      }
    }, 0);

    return () => clearTimeout(timerId);
  }, [theme]);

  return { theme };
};
