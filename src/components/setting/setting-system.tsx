import React from "react";
import { useTranslation } from "react-i18next";

import SettingClash from "./setting-clash";
import { SettingList } from "./mods/setting-comp";
import SettingVergeAdvanced from "./setting-verge-advanced";
import SettingVergeBasic from "./setting-verge-basic";

interface Props {
  onError?: (err: Error) => void;
}

const SettingSystem = ({ onError }: Props) => {
  const { t } = useTranslation();

  return (
    <SettingList title={t("settings.sections.system.title")}>
      <SettingClash onError={onError ?? (() => {})} embedded />
      <SettingVergeBasic onError={onError} embedded />
      <SettingVergeAdvanced onError={onError} embedded />
    </SettingList>
  );
};

export default SettingSystem;
