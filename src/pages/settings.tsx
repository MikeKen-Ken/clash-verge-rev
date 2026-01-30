import { Box } from "@mui/material";
import { useTranslation } from "react-i18next";

import { BasePage } from "@/components/base";
import SettingSystem from "@/components/setting/setting-system";
import { showNotice } from "@/services/notice-service";
import { useThemeMode } from "@/services/states";

const SettingPage = () => {
  const { t } = useTranslation();

  const onError = (err: any) => {
    showNotice.error(err);
  };

  const mode = useThemeMode();
  const isDark = mode === "light" ? false : true;

  return (
    <BasePage title={t("settings.page.title")}>
      <Box
        sx={{
          borderRadius: 2,
          backgroundColor: isDark ? "#282a36" : "#ffffff",
        }}
      >
        <SettingSystem onError={onError} />
      </Box>
    </BasePage>
  );
};

export default SettingPage;
