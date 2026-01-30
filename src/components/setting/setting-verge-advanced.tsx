import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef, TooltipIcon } from "@/components/base";
import { openLogsDir } from "@/services/cmds";
import { showNotice } from "@/services/notice-service";
import { checkUpdateSafe as checkUpdate } from "@/services/update";

import { BackupViewer } from "./mods/backup-viewer";
import { HotkeyViewer } from "./mods/hotkey-viewer";
import { LayoutViewer } from "./mods/layout-viewer";
import { MiscViewer } from "./mods/misc-viewer";
import { SettingItem, SettingList } from "./mods/setting-comp";
import { ThemeViewer } from "./mods/theme-viewer";
import { UpdateViewer } from "./mods/update-viewer";

interface Props {
  onError?: (err: Error) => void;
}

const SettingVergeAdvanced = ({ onError: _ }: Props) => {
  const { t } = useTranslation();

  const hotkeyRef = useRef<DialogRef>(null);
  const miscRef = useRef<DialogRef>(null);
  const themeRef = useRef<DialogRef>(null);
  const layoutRef = useRef<DialogRef>(null);
  const updateRef = useRef<DialogRef>(null);
  const backupRef = useRef<DialogRef>(null);

  const onCheckUpdate = async () => {
    try {
      const info = await checkUpdate();
      if (!info?.available) {
        showNotice.success(
          "settings.components.verge.advanced.notifications.latestVersion",
        );
      } else {
        updateRef.current?.open();
      }
    } catch (err: any) {
      showNotice.error(err);
    }
  };

  return (
    <SettingList title={t("settings.components.verge.advanced.title")}>
      <ThemeViewer ref={themeRef} />
      <HotkeyViewer ref={hotkeyRef} />
      <MiscViewer ref={miscRef} />
      <LayoutViewer ref={layoutRef} />
      <UpdateViewer ref={updateRef} />
      <BackupViewer ref={backupRef} />

      <SettingItem
        onClick={() => backupRef.current?.open()}
        label={t("settings.components.verge.advanced.fields.backupSetting")}
        extra={
          <TooltipIcon
            title={t("settings.components.verge.advanced.tooltips.backupInfo")}
            sx={{ opacity: "0.7" }}
          />
        }
      />

      <SettingItem
        onClick={openLogsDir}
        label={t("settings.components.verge.advanced.fields.openLogsDir")}
      />

      <SettingItem
        onClick={onCheckUpdate}
        label={t("settings.components.verge.advanced.fields.checkUpdates")}
      />
    </SettingList>
  );
};

export default SettingVergeAdvanced;
