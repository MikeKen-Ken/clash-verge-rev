import { SettingsRounded } from "@mui/icons-material";
import { TextField, Typography } from "@mui/material";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef, TooltipIcon } from "@/components/base";
import { useClash } from "@/hooks/use-clash";
import { useVerge } from "@/hooks/use-verge";
import { invoke_uwp_tool } from "@/services/cmds";
import getSystem from "@/utils/get-system";

import { ClashCoreViewer } from "./mods/clash-core-viewer";
import { ClashPortViewer } from "./mods/clash-port-viewer";
import { NetworkInterfaceViewer } from "./mods/network-interface-viewer";
import { SettingItem, SettingList } from "./mods/setting-comp";

const isWIN = getSystem() === "windows";

interface Props {
  onError: (err: Error) => void;
  embedded?: boolean;
}

const SettingClash = ({ onError, embedded }: Props) => {
  const { t } = useTranslation();

  const { version } = useClash();
  const { verge } = useVerge();

  const { verge_mixed_port } = verge ?? {};

  const portRef = useRef<DialogRef>(null);
  const coreRef = useRef<DialogRef>(null);
  const networkRef = useRef<DialogRef>(null);
  const content = (
    <>
      {!embedded && <ClashPortViewer ref={portRef} />}
      <ClashCoreViewer ref={coreRef} />
      <NetworkInterfaceViewer ref={networkRef} />

      {!embedded && (
        <SettingItem label={t("settings.sections.clash.form.fields.portConfig")}>
          <TextField
            autoComplete="new-password"
            disabled={false}
            size="small"
            value={verge_mixed_port ?? 7897}
            sx={{ width: 100, input: { py: "7.5px", cursor: "pointer" } }}
            onClick={(e) => {
              portRef.current?.open();
              (e.target as any).blur();
            }}
          />
        </SettingItem>
      )}

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
