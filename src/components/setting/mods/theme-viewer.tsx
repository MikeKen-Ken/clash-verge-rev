import { EditRounded } from "@mui/icons-material";
import {
  Button,
  FormControl,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  styled,
  TextField,
  useTheme,
} from "@mui/material";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useLockFn } from "ahooks";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { useTranslation } from "react-i18next";

import { BaseDialog, DialogRef } from "@/components/base";
import { EditorViewer } from "@/components/profile/editor-viewer";
import { useVerge } from "@/hooks/use-verge";
import { defaultDarkTheme, defaultTheme } from "@/pages/_theme";
import { clearUiBackground, copyUiBackground, downloadUiWallpapersWebdav, removeUiBackground, uploadUiWallpapersWebdav } from "@/services/cmds";
import { showNotice } from "@/services/notice-service";

export function ThemeViewer(props: { ref?: React.Ref<DialogRef> }) {
  const { ref } = props;
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const { verge, patchVerge, mutateVerge } = useVerge();
  const { theme_setting } = verge ?? {};
  const [theme, setTheme] = useState(theme_setting || {});
  // Latest theme ref to avoid stale closures when saving CSS
  const themeRef = useRef(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useImperativeHandle(ref, () => ({
    open: () => {
      setOpen(true);
      setTheme({ ...theme_setting });
    },
    close: () => setOpen(false),
  }));

  const textProps = {
    size: "small",
    autoComplete: "off",
    sx: { width: 135 },
  } as const;

  const handleChange = (field: keyof typeof theme) => (e: any) => {
    setTheme((t) => ({ ...t, [field]: e.target.value }));
  };

  const onSave = useLockFn(async () => {
    try {
      await patchVerge({ theme_setting: theme });
      setOpen(false);
    } catch (err) {
      showNotice.error(err);
    }
  });

  const { palette } = useTheme();

  const dt = palette.mode === "light" ? defaultTheme : defaultDarkTheme;

  type ThemeKey = keyof typeof theme & keyof typeof defaultTheme;

  const fieldDefinitions: Array<{ labelKey: string; key: ThemeKey }> = useMemo(
    () => [
      {
        labelKey: "settings.components.verge.theme.fields.primaryColor",
        key: "primary_color",
      },
      {
        labelKey: "settings.components.verge.theme.fields.secondaryColor",
        key: "secondary_color",
      },
      {
        labelKey: "settings.components.verge.theme.fields.primaryText",
        key: "primary_text",
      },
      {
        labelKey: "settings.components.verge.theme.fields.secondaryText",
        key: "secondary_text",
      },
      {
        labelKey: "settings.components.verge.theme.fields.infoColor",
        key: "info_color",
      },
      {
        labelKey: "settings.components.verge.theme.fields.warningColor",
        key: "warning_color",
      },
      {
        labelKey: "settings.components.verge.theme.fields.errorColor",
        key: "error_color",
      },
      {
        labelKey: "settings.components.verge.theme.fields.successColor",
        key: "success_color",
      },
    ],
    [],
  );

  // Stable loader that returns a fresh Promise each call so EditorViewer
  // can retry/refresh and always read the latest staged CSS from state.
  const loadCss = useCallback(
    () => Promise.resolve(themeRef.current?.css_injection ?? ""),
    [],
  );

  const renderItem = (labelKey: string, key: ThemeKey) => {
    const label = t(labelKey);
    return (
      <Item key={key}>
        <ListItemText primary={label} />
        <Round sx={{ background: theme[key] || dt[key] }} />
        <TextField
          {...textProps}
          value={theme[key] ?? ""}
          placeholder={dt[key]}
          onChange={handleChange(key)}
          onKeyDown={(e) => e.key === "Enter" && onSave()}
        />
      </Item>
    );
  };

  const wallpaperList =
    theme.background_images && theme.background_images.length > 0
      ? theme.background_images
      : theme.background_image
        ? [theme.background_image]
        : [];
  const playback = theme.background_playback === "random" ? "random" : "fixed";
  const intervalSeconds = theme.background_interval_seconds || 300;

  const setWallpaperLibrary = (
    images: string[],
    extra?: Partial<typeof theme>,
  ) => {
    setTheme((current) => ({
      ...current,
      ...extra,
      background_images: images,
      background_image: images[0] || "",
    }));
  };

  return (
    <BaseDialog
      open={open}
      title={t("settings.components.verge.theme.title")}
      okBtn={t("shared.actions.save")}
      cancelBtn={t("shared.actions.cancel")}
      contentSx={{ width: 420, maxHeight: 560, overflow: "auto", pb: 0 }}
      onClose={() => setOpen(false)}
      onCancel={() => setOpen(false)}
      onOk={onSave}
    >
      <List sx={{ pt: 0 }}>
        {fieldDefinitions.map((field) => renderItem(field.labelKey, field.key))}

        <Item>
          <ListItemText
            primary={t("settings.components.verge.theme.fields.fontFamily")}
          />
          <TextField
            {...textProps}
            value={theme.font_family ?? ""}
            onChange={handleChange("font_family")}
            onKeyDown={(e) => e.key === "Enter" && onSave()}
          />
        </Item>
        <Item sx={{ alignItems: "flex-start", flexWrap: "wrap", gap: 1 }}>
          <ListItemText
            primary={t("settings.components.verge.theme.fields.backgroundImage")}
            secondary={
              wallpaperList.length > 0
                ? t(
                    "settings.components.verge.theme.fields.backgroundImageCount",
                    { count: wallpaperList.length },
                  )
                : t("settings.components.verge.theme.fields.backgroundImageNone")
            }
            sx={{ mr: 1, minWidth: 160 }}
          />
          <Button
            variant="outlined"
            size="small"
            onClick={async () => {
              try {
                const selected = await openDialog({
                  directory: false,
                  multiple: true,
                  filters: [
                    {
                      name: t(
                        "settings.components.verge.theme.fields.backgroundImage",
                      ),
                      extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
                    },
                  ],
                });
                if (!selected) return;
                const files = Array.isArray(selected) ? selected : [selected];
                const dests: string[] = [];
                for (const file of files) {
                  dests.push(await copyUiBackground(String(file)));
                }
                setWallpaperLibrary([...wallpaperList, ...dests]);
              } catch (err) {
                showNotice.error(err);
              }
            }}
          >
            {t("settings.components.verge.basic.actions.browse")}
          </Button>
          {wallpaperList.length > 0 ? (
            <Button
              size="small"
              onClick={async () => {
                try {
                  await clearUiBackground();
                  setWallpaperLibrary([]);
                } catch (err) {
                  showNotice.error(err);
                }
              }}
            >
              {t("shared.actions.clear")}
            </Button>
          ) : null}
          <Button
            size="small"
            onClick={async () => {
              try {
                await uploadUiWallpapersWebdav();
                showNotice.success(
                  t("settings.components.verge.theme.fields.webdavUploadOk"),
                );
              } catch (err) {
                showNotice.error(err);
              }
            }}
          >
            {t("settings.components.verge.theme.fields.webdavUpload")}
          </Button>
          <Button
            size="small"
            onClick={async () => {
              try {
                await downloadUiWallpapersWebdav();
                await mutateVerge();
                showNotice.success(
                  t("settings.components.verge.theme.fields.webdavDownloadOk"),
                );
                setOpen(false);
              } catch (err) {
                showNotice.error(err);
              }
            }}
          >
            {t("settings.components.verge.theme.fields.webdavDownload")}
          </Button>
        </Item>
        {wallpaperList.length > 0 ? (
          <Item sx={{ alignItems: "flex-start", flexWrap: "wrap", gap: 1 }}>
            <ListItemText
              primary={t(
                "settings.components.verge.theme.fields.backgroundPlayback",
              )}
              sx={{ mr: 1, minWidth: 160 }}
            />
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select
                value={playback}
                onChange={(event) =>
                  setTheme((current) => ({
                    ...current,
                    background_playback: event.target.value as string,
                  }))
                }
              >
                <MenuItem value="fixed">
                  {t("settings.components.verge.theme.fields.playbackFixed")}
                </MenuItem>
                <MenuItem value="random">
                  {t("settings.components.verge.theme.fields.playbackRandom")}
                </MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select
                value={intervalSeconds}
                onChange={(event) =>
                  setTheme((current) => ({
                    ...current,
                    background_interval_seconds: Number(event.target.value),
                  }))
                }
              >
                <MenuItem value={30}>
                  {t("settings.components.verge.theme.fields.interval30s")}
                </MenuItem>
                <MenuItem value={60}>
                  {t("settings.components.verge.theme.fields.interval1m")}
                </MenuItem>
                <MenuItem value={300}>
                  {t("settings.components.verge.theme.fields.interval5m")}
                </MenuItem>
                <MenuItem value={900}>
                  {t("settings.components.verge.theme.fields.interval15m")}
                </MenuItem>
                <MenuItem value={3600}>
                  {t("settings.components.verge.theme.fields.interval1h")}
                </MenuItem>
              </Select>
            </FormControl>
          </Item>
        ) : null}
        {wallpaperList.map((path) => (
          <Item key={path} sx={{ gap: 1 }}>
            <ListItemText
              primary={path.split(/[/\\]/).pop()}
              sx={{ mr: 1, minWidth: 160 }}
            />
            <Button
              size="small"
              onClick={async () => {
                try {
                  await removeUiBackground(path);
                  setWallpaperLibrary(wallpaperList.filter((item) => item !== path));
                } catch (err) {
                  showNotice.error(err);
                }
              }}
            >
              {t("shared.actions.clear")}
            </Button>
          </Item>
        ))}
        <Item>
          <ListItemText
            primary={t("settings.components.verge.theme.fields.cssInjection")}
          />
          <Button
            startIcon={<EditRounded />}
            variant="outlined"
            onClick={() => {
              setEditorOpen(true);
            }}
          >
            {t("settings.components.verge.theme.actions.editCss")}
          </Button>
          {editorOpen && (
            <EditorViewer
              open={true}
              title={t("settings.components.verge.theme.dialogs.editCssTitle")}
              initialData={loadCss}
              dataKey="theme-css"
              language="css"
              onSave={async (_prev, curr) => {
                // Only stage the CSS change locally. Persistence happens
                // when the outer Theme dialog's Save button is pressed.
                const prevTheme = themeRef.current || {};
                const nextCss = curr ?? "";
                setTheme({ ...prevTheme, css_injection: nextCss });
              }}
              onClose={() => {
                setEditorOpen(false);
              }}
            />
          )}
        </Item>
      </List>
    </BaseDialog>
  );
}

const Item = styled(ListItem)(() => ({
  padding: "5px 2px",
}));

const Round = styled("div")(() => ({
  width: "24px",
  height: "24px",
  borderRadius: "18px",
  display: "inline-block",
  marginRight: "8px",
}));
