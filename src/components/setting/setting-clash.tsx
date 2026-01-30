import { LanRounded, SettingsRounded } from "@mui/icons-material";
import { TextField, Typography } from "@mui/material";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef, Switch, TooltipIcon } from "@/components/base";
import { useClash } from "@/hooks/use-clash";
import { useVerge } from "@/hooks/use-verge";
import { invoke_uwp_tool } from "@/services/cmds";
import getSystem from "@/utils/get-system";

import { ClashCoreViewer } from "./mods/clash-core-viewer";
import { ClashPortViewer } from "./mods/clash-port-viewer";
import { ControllerViewer } from "./mods/controller-viewer";
import { HeaderConfiguration } from "./mods/external-controller-cors";
import { GuardState } from "./mods/guard-state";
import { NetworkInterfaceViewer } from "./mods/network-interface-viewer";
import { SettingItem, SettingList } from "./mods/setting-comp";
import { TunnelsViewer } from "./mods/tunnels-viewer";
import { WebUIViewer } from "./mods/web-ui-viewer";

const isWIN = getSystem() === "windows";

interface Props {
  onError: (err: Error) => void;
}

const SettingClash = ({ onError }: Props) => {
  const { t } = useTranslation();

  const { clash, version, mutateClash, patchClash } = useClash();
  const { verge } = useVerge();

  const { ipv6, "allow-lan": allowLan } = clash ?? {};

  const { verge_mixed_port } = verge ?? {};

  const webRef = useRef<DialogRef>(null);
  const portRef = useRef<DialogRef>(null);
  const ctrlRef = useRef<DialogRef>(null);
  const coreRef = useRef<DialogRef>(null);
  const networkRef = useRef<DialogRef>(null);
  const corsRef = useRef<DialogRef>(null);
  const tunnelRef = useRef<DialogRef>(null);

  const onSwitchFormat = (_e: any, value: boolean) => value;
  const onChangeData = (patch: Partial<IConfigData>) => {
    mutateClash((old) => ({ ...old!, ...patch }), false);
  };
  return (
    <SettingList title={t("settings.sections.clash.title")}>
      <WebUIViewer ref={webRef} />
      <ClashPortViewer ref={portRef} />
      <ControllerViewer ref={ctrlRef} />
      <ClashCoreViewer ref={coreRef} />
      <NetworkInterfaceViewer ref={networkRef} />
      <HeaderConfiguration ref={corsRef} />
      <TunnelsViewer ref={tunnelRef} />
      <SettingItem
        label={t("settings.sections.clash.form.fields.allowLan")}
        extra={
          <TooltipIcon
            title={t("settings.sections.clash.form.tooltips.networkInterface")}
            color={"inherit"}
            icon={LanRounded}
            onClick={() => {
              networkRef.current?.open();
            }}
          />
        }
      >
        <GuardState
          value={allowLan ?? false}
          valueProps="checked"
          onCatch={onError}
          onFormat={onSwitchFormat}
          onChange={(e) => onChangeData({ "allow-lan": e })}
          onGuard={(e) => patchClash({ "allow-lan": e })}
        >
          <Switch edge="end" />
        </GuardState>
      </SettingItem>

      <SettingItem label={t("settings.sections.clash.form.fields.ipv6")}>
        <GuardState
          value={ipv6 ?? false}
          valueProps="checked"
          onCatch={onError}
          onFormat={onSwitchFormat}
          onChange={(e) => onChangeData({ ipv6: e })}
          onGuard={(e) => patchClash({ ipv6: e })}
        >
          <Switch edge="end" />
        </GuardState>
      </SettingItem>

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

      <SettingItem
        label={t("settings.sections.clash.form.fields.external")}
        extra={
          <TooltipIcon
            title={t("settings.sections.externalCors.tooltips.open")}
            icon={SettingsRounded}
            onClick={(e) => {
              e.stopPropagation();
              corsRef.current?.open();
            }}
          />
        }
        onClick={() => {
          ctrlRef.current?.open();
        }}
      />

      <SettingItem
        onClick={() => webRef.current?.open()}
        label={t("settings.sections.clash.form.fields.webUI")}
      />

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

      <SettingItem
        label={t("settings.sections.clash.form.fields.tunnels.title")}
        onClick={() => tunnelRef.current?.open()}
      />
    </SettingList>
  );
};

export default SettingClash;
