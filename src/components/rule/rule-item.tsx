import { OpenInNewRounded } from "@mui/icons-material";
import { IconButton, styled, Box, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { useAppData } from "@/providers/app-data-context";
import { openWebUrl } from "@/services/cmds";

const Item = styled(Box)(({ theme }) => ({
  display: "flex",
  padding: "4px 16px",
  color: theme.palette.text.primary,
  alignItems: "center",
}));

const COLOR = [
  "primary",
  "secondary",
  "info.main",
  "warning.main",
  "success.main",
];

interface Props {
  index: number;
  value: IRuleItem;
}

const parseColor = (text: string) => {
  if (text === "REJECT" || text === "REJECT-DROP") return "error.main";
  if (text === "DIRECT") return "text.primary";

  let sum = 0;
  for (let i = 0; i < text.length; i++) {
    sum += text.charCodeAt(i);
  }
  return COLOR[sum % COLOR.length];
};

const RuleItem = (props: Props) => {
  const { index, value } = props;
  const { t } = useTranslation();
  const { ruleProviders } = useAppData();
  const provider =
    value.type === "RuleSet" && value.payload
      ? (ruleProviders?.[value.payload] as IRuleProviderItem | undefined)
      : undefined;
  const providerUrl = provider?.url;

  const handleOpenRepo = () => {
    if (providerUrl) openWebUrl(providerUrl);
  };

  return (
    <Item sx={{ borderBottom: "1px solid var(--divider-color)" }}>
      <Typography
        color="text.secondary"
        variant="body2"
        sx={{ lineHeight: 2, minWidth: 30, mr: 2.25, textAlign: "center" }}
      >
        {index}
      </Typography>

      <Box sx={{ userSelect: "text", flex: 1 }}>
        <Typography component="h6" variant="subtitle1" color="text.primary">
          {value.payload || "-"}
        </Typography>

        <Typography
          component="span"
          variant="body2"
          color="text.secondary"
          sx={{ mr: 3, minWidth: 120, display: "inline-block" }}
        >
          {value.type}
        </Typography>

        <Typography
          component="span"
          variant="body2"
          color={parseColor(value.proxy)}
        >
          {value.proxy}
        </Typography>
      </Box>

      {providerUrl ? (
        <IconButton
          size="small"
          onClick={handleOpenRepo}
          title={t("rules.page.provider.actions.openRepo")}
          aria-label={t("rules.page.provider.actions.openRepo")}
          sx={{ ml: 0.5 }}
        >
          <OpenInNewRounded fontSize="small" />
        </IconButton>
      ) : null}
    </Item>
  );
};

export default RuleItem;
