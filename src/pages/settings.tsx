import { Box } from "@mui/material";
import { useTranslation } from "react-i18next";

import { BasePage } from "@/components/base";
import SettingSystem from "@/components/setting/setting-system";
import { NetworkHealthPanel } from "@/components/setting/network-health";
import { showNotice } from "@/services/notice-service";

const SettingPage = () => {
  const { t } = useTranslation();

  const onError = (err: any) => {
    showNotice.error(err);
  };

  return (
    <BasePage title={t("settings.page.title")} header={<NetworkHealthPanel />}>
      <Box
        className="setting-panel"
        sx={{
          borderRadius: 2,
        }}
      >
        <SettingSystem onError={onError} />
      </Box>
    </BasePage>
  );
};

export default SettingPage;
