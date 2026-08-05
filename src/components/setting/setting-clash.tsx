import { SettingsRounded } from "@mui/icons-material";
import { Typography } from "@mui/material";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef, TooltipIcon } from "@/components/base";
import { useClash } from "@/hooks/use-clash";
import { invoke_uwp_tool } from "@/services/cmds";
import getSystem from "@/utils/get-system";

import { ClashCoreViewer } from "./mods/clash-core-viewer";
import { SettingItem, SettingList } from "./mods/setting-comp";

const isWIN = getSystem() === "windows";

interface Props {
  onError: (err: Error) => void;
  embedded?: boolean;
}

const SettingClash = ({ onError: _, embedded }: Props) => {
  const { t } = useTranslation();

  const { version } = useClash();

  const coreRef = useRef<DialogRef>(null);
  const content = (
    <>
      <ClashCoreViewer ref={coreRef} />

      <SettingItem
        label={t("settings.sections.clash.form.fields.clashCore")}
        extra={
          <TooltipIcon
            icon={SettingsRounded}
            onClick={() => coreRef.current?.open()}
          />
        }
      >
        <Typography sx={{ py: "7px", pr: 1 }}>{version}</Typography>
      </SettingItem>

      {isWIN && (
        <SettingItem
          onClick={invoke_uwp_tool}
          label={t("settings.sections.clash.form.fields.openUwpTool")}
          extra={
            <TooltipIcon
              title={t("settings.sections.clash.form.tooltips.openUwpTool")}
              sx={{ opacity: "0.7" }}
            />
          }
        />
      )}
    </>
  );

  if (embedded) return content;
  return (
    <SettingList title={t("settings.sections.clash.title")}>
      {content}
    </SettingList>
  );
};

export default SettingClash;
