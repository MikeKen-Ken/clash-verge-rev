import { FormControlLabel, Switch, Tooltip, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function HideUnavailableNodesControl({ checked, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <Tooltip title={t("proxies.page.tooltips.hideUnavailableNodes")}>
      <FormControlLabel
        sx={{ mr: 0 }}
        control={
          <Switch
            size="small"
            checked={checked}
            onChange={(_, value) => onChange(value)}
          />
        }
        label={
          <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
            {t("proxies.page.labels.hideUnavailableNodes")}
          </Typography>
        }
      />
    </Tooltip>
  );
}
