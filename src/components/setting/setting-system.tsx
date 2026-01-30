import React, { useRef } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef } from "@/components/base";
import ProxyControlSwitches from "@/components/shared/proxy-control-switches";

import { SettingList } from "./mods/setting-comp";
import { TunViewer } from "./mods/tun-viewer";

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
    </SettingList>
  );
};

export default SettingSystem;
