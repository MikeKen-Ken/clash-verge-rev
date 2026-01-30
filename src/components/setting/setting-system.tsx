import React, { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef } from "@/components/base";
import ProxyControlSwitches from "@/components/shared/proxy-control-switches";

import SettingClash from "./setting-clash";
import { SettingList } from "./mods/setting-comp";
import { TunViewer } from "./mods/tun-viewer";
import SettingVergeAdvanced from "./setting-verge-advanced";
import SettingVergeBasic from "./setting-verge-basic";

interface Props {
  onError?: (err: Error) => void;
}

const SettingSystem = ({ onError }: Props) => {
  const { t } = useTranslation();

  const tunRef = useRef<DialogRef>(null);

  return (
    <SettingList title={t("settings.sections.system.title")}>
      <TunViewer ref={tunRef} />

      <ProxyControlSwitches
        label={t("settings.sections.system.toggles.tunMode")}
        onError={onError}
      />

      <SettingClash onError={onError ?? (() => {})} embedded />
      <SettingVergeBasic onError={onError} embedded />
      <SettingVergeAdvanced onError={onError} embedded />
    </SettingList>
  );
};

export default SettingSystem;
