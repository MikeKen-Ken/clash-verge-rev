import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef, TooltipIcon } from "@/components/base";

import { BackupViewer } from "./mods/backup-viewer";
import { HotkeyViewer } from "./mods/hotkey-viewer";
import { LayoutViewer } from "./mods/layout-viewer";
import { MiscViewer } from "./mods/misc-viewer";
import { SettingItem, SettingList } from "./mods/setting-comp";
import { ThemeViewer } from "./mods/theme-viewer";

interface Props {
  onError?: (err: Error) => void;
  embedded?: boolean;
}

const SettingVergeAdvanced = ({ onError: _, embedded }: Props) => {
  const { t } = useTranslation();

  const hotkeyRef = useRef<DialogRef>(null);
  const miscRef = useRef<DialogRef>(null);
  const themeRef = useRef<DialogRef>(null);
  const layoutRef = useRef<DialogRef>(null);
  const backupRef = useRef<DialogRef>(null);

  const content = (
    <>
      <ThemeViewer ref={themeRef} />
      <HotkeyViewer ref={hotkeyRef} />
      <MiscViewer ref={miscRef} />
      <LayoutViewer ref={layoutRef} />
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
    </>
  );

  if (embedded) return content;
  return (
    <SettingList title={t("settings.components.verge.advanced.title")}>
      {content}
    </SettingList>
  );
};

export default SettingVergeAdvanced;
