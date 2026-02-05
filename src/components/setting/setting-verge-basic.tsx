import { Button, Input, MenuItem, Select } from "@mui/material";
import { open } from "@tauri-apps/plugin-dialog";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef, TooltipIcon } from "@/components/base";
import { useVerge } from "@/hooks/use-verge";
import { navItems } from "@/pages/_routers";

import { BackupViewer } from "./mods/backup-viewer";
import { ConfigViewer } from "./mods/config-viewer";
import { GuardState } from "./mods/guard-state";
import { HotkeyViewer } from "./mods/hotkey-viewer";
import { LayoutViewer } from "./mods/layout-viewer";
import { MiscViewer } from "./mods/misc-viewer";
import { SettingItem, SettingList } from "./mods/setting-comp";
import { ThemeModeSwitch } from "./mods/theme-mode-switch";
import { ThemeViewer } from "./mods/theme-viewer";

interface Props {
  onError?: (err: Error) => void;
  embedded?: boolean;
}

const SettingVergeBasic = ({ onError, embedded }: Props) => {
  const { t } = useTranslation();

  const { verge, patchVerge, mutateVerge } = useVerge();
  const { theme_mode, startup_script, start_page } = verge ?? {};
  const defaultStartPage = "/proxies";
  const configRef = useRef<DialogRef>(null);
  const hotkeyRef = useRef<DialogRef>(null);
  const miscRef = useRef<DialogRef>(null);
  const themeRef = useRef<DialogRef>(null);
  const layoutRef = useRef<DialogRef>(null);
  const backupRef = useRef<DialogRef>(null);

  const onChangeData = (patch: any) => {
    mutateVerge({ ...verge, ...patch }, false);
  };

  const content = (
    <>
      <ThemeViewer ref={themeRef} />
      <ConfigViewer ref={configRef} />
      <HotkeyViewer ref={hotkeyRef} />
      <MiscViewer ref={miscRef} />
      <LayoutViewer ref={layoutRef} />
      <BackupViewer ref={backupRef} />

      <SettingItem
        label={t("settings.components.verge.basic.fields.themeMode")}
      >
        <GuardState
          value={theme_mode}
          onCatch={onError}
          onChange={(e) => onChangeData({ theme_mode: e })}
          onGuard={(e) => patchVerge({ theme_mode: e })}
        >
          <ThemeModeSwitch />
        </GuardState>
      </SettingItem>

      <SettingItem
        label={t("settings.components.verge.basic.fields.startPage")}
      >
        <GuardState
          value={start_page ?? defaultStartPage}
          onCatch={onError}
          onFormat={(e: any) => e.target.value}
          onChange={(e) => onChangeData({ start_page: e })}
          onGuard={(e) => patchVerge({ start_page: e })}
        >
          <Select size="small" sx={{ width: 140, "> div": { py: "7.5px" } }}>
            {navItems
              .filter((page) => page.path !== "/")
              .map((page: { label: string; path: string }) => (
                <MenuItem key={page.path} value={page.path}>
                  {t(page.label)}
                </MenuItem>
              ))}
          </Select>
        </GuardState>
      </SettingItem>

      <SettingItem
        label={t("settings.components.verge.basic.fields.startupScript")}
      >
        <GuardState
          value={startup_script ?? ""}
          onCatch={onError}
          onFormat={(e: any) => e.target.value}
          onChange={(e) => onChangeData({ startup_script: e })}
          onGuard={(e) => patchVerge({ startup_script: e })}
        >
          <Input
            value={startup_script}
            disabled
            disableUnderline
            sx={{ width: 230 }}
            endAdornment={
              <>
                <Button
                  onClick={async () => {
                    const selected = await open({
                      directory: false,
                      multiple: false,
                      filters: [
                        {
                          name: "Shell Script",
                          extensions: ["sh", "bat", "ps1"],
                        },
                      ],
                    });
                    if (selected) {
                      onChangeData({ startup_script: `${selected}` });
                      patchVerge({ startup_script: `${selected}` });
                    }
                  }}
                >
                  {t("settings.components.verge.basic.actions.browse")}
                </Button>
                {startup_script && (
                  <Button
                    onClick={async () => {
                      onChangeData({ startup_script: "" });
                      patchVerge({ startup_script: "" });
                    }}
                  >
                    {t("shared.actions.clear")}
                  </Button>
                )}
              </>
            }
          ></Input>
        </GuardState>
      </SettingItem>

      <SettingItem
        onClick={() => themeRef.current?.open()}
        label={t("settings.components.verge.basic.fields.themeSetting")}
      />

      <SettingItem
        onClick={() => layoutRef.current?.open()}
        label={t("settings.components.verge.basic.fields.layoutSetting")}
      />

      <SettingItem
        onClick={() => miscRef.current?.open()}
        label={t("settings.components.verge.basic.fields.misc")}
      />

      <SettingItem
        onClick={() => hotkeyRef.current?.open()}
        label={t("settings.components.verge.basic.fields.hotkeySetting")}
      />
    </>
  );

  if (embedded) return content;
  return (
    <SettingList title={t("settings.components.verge.basic.title")}>
      {content}
    </SettingList>
  );
};

export default SettingVergeBasic;
