import { OpenInNewRounded, RefreshRounded, StorageOutlined } from "@mui/icons-material";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Typography,
  alpha,
  styled,
} from "@mui/material";
import { useLockFn } from "ahooks";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mutate } from "swr";
import { updateRuleProvider } from "tauri-plugin-mihomo-api";

import {
  ruleProviderUrlsSwrKey,
  useRuleProviderUrls,
  useRulesetOrderFromRules,
} from "@/hooks/use-rule-provider-urls";
import { useAppData } from "@/providers/app-data-context";
import { openWebUrl } from "@/services/cmds";
import { showNotice } from "@/services/notice-service";

// 将规则集的原始 url 转为更友好的仓库/文件页面地址
const toRepoUrl = (url: string): string => {
  try {
    const u = new URL(url);

    // 处理 GitHub Raw: raw.githubusercontent.com/owner/repo/branch/path...
    if (u.hostname === "raw.githubusercontent.com") {
      const [owner, repo, branch, ...rest] = u.pathname.replace(/^\/+/, "").split("/");
      if (!owner || !repo) return url;
      if (!branch || rest.length === 0) {
        return `https://github.com/${owner}/${repo}`;
      }
      return `https://github.com/${owner}/${repo}/blob/${branch}/${rest.join("/")}`;
    }

    return url;
  } catch {
    return url;
  }
};

// 辅助组件 - 类型框
const TypeBox = styled(Box)<{ component?: React.ElementType }>(({ theme }) => ({
  display: "inline-block",
  border: "1px solid #ccc",
  borderColor: alpha(theme.palette.secondary.main, 0.5),
  color: alpha(theme.palette.secondary.main, 0.8),
  borderRadius: 4,
  fontSize: 10,
  marginRight: "4px",
  padding: "0 2px",
  lineHeight: 1.25,
}));

export const ProviderButton = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { ruleProviders, refreshRules, refreshRuleProviders } = useAppData();
  const [updating, setUpdating] = useState<Record<string, boolean>>({});

  // 检查是否有提供者
  const hasProviders = Object.keys(ruleProviders || {}).length > 0;
  // 从运行中配置解析的 rule-providers url（API 未返回 url 时使用）
  const ruleProviderUrls = useRuleProviderUrls();
  // 从运行中配置的 rules 里 RULE-SET 首次出现顺序，用于列表排序
  const rulesetOrder = useRulesetOrderFromRules();

  // 每次打开规则集合弹窗时重新拉取规则提供者列表和运行中配置，确保顺序与 ruleset 列表都是最新的
  useEffect(() => {
    if (open) {
      void refreshRuleProviders();
      void mutate(ruleProviderUrlsSwrKey);
    }
  }, [open, refreshRuleProviders]);

  // 更新单个规则提供者
  const updateProvider = useLockFn(async (name: string) => {
    try {
      // 设置更新状态
      setUpdating((prev) => ({ ...prev, [name]: true }));

      await updateRuleProvider(name);

      // 刷新数据
      await refreshRules();
      await refreshRuleProviders();

      showNotice.success(
        "rules.feedback.notifications.provider.updateSuccess",
        {
          name,
        },
      );
    } catch (err) {
      showNotice.error("rules.feedback.notifications.provider.updateFailed", {
        name,
        message: String(err),
      });
    } finally {
      // 清除更新状态
      setUpdating((prev) => ({ ...prev, [name]: false }));
    }
  });

  // 更新所有规则提供者
  const updateAllProviders = useLockFn(async () => {
    try {
      // 获取所有provider的名称
      const allProviders = Object.keys(ruleProviders || {});
      if (allProviders.length === 0) {
        showNotice.info("rules.feedback.notifications.provider.none");
        return;
      }

      // 设置所有provider为更新中状态
      const newUpdating = allProviders.reduce(
        (acc, key) => {
          acc[key] = true;
          return acc;
        },
        {} as Record<string, boolean>,
      );
      setUpdating(newUpdating);

      // 改为串行逐个更新所有provider
      for (const name of allProviders) {
        try {
          await updateRuleProvider(name);
          // 每个更新完成后更新状态
          setUpdating((prev) => ({ ...prev, [name]: false }));
        } catch (err) {
          console.error(`更新 ${name} 失败`, err);
          // 继续执行下一个，不中断整体流程
        }
      }

      // 刷新数据
      await refreshRules();
      await refreshRuleProviders();

      showNotice.success("rules.feedback.notifications.provider.allUpdated");
    } catch (err) {
      showNotice.error("rules.feedback.notifications.provider.genericError", {
        message: String(err),
      });
    } finally {
      // 清除所有更新状态
      setUpdating({});
    }
  });

  const handleClose = () => {
    setOpen(false);
  };

  if (!hasProviders) return null;

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<StorageOutlined />}
        onClick={() => setOpen(true)}
      >
        {t("rules.page.provider.trigger")}
      </Button>

      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box
            display="flex"
            justifyContent="space-between"
            alignItems="center"
          >
            <Typography variant="h6">
              {t("rules.page.provider.dialogTitle")}
            </Typography>
            <Button
              variant="contained"
              size="small"
              onClick={updateAllProviders}
            >
              {t("rules.page.provider.actions.updateAll")}
            </Button>
          </Box>
        </DialogTitle>

        <DialogContent>
          <List sx={{ py: 0, minHeight: 250 }}>
            {(() => {
              // 按 rules 里 RULE-SET 首次出现顺序显示，不在 rules 中的排在后面并按字母序
              const configOrder = rulesetOrder.length > 0 ? rulesetOrder : Object.keys(ruleProviderUrls);
              return Object.entries(ruleProviders || {})
                .sort(([a], [b]) => {
                  const iA = configOrder.indexOf(a);
                  const iB = configOrder.indexOf(b);
                  if (iA === -1 && iB === -1) return a.localeCompare(b);
                  if (iA === -1) return 1;
                  if (iB === -1) return -1;
                  return iA - iB;
                })
                .map(([key, item]) => {
                const provider = item;
                const time = dayjs(provider.updatedAt);
                const isUpdating = updating[key];

                const rawUrl =
                  (provider as IRuleProviderItem).url ?? ruleProviderUrls[key];
                const providerUrl = rawUrl ? toRepoUrl(rawUrl) : undefined;

                return (
                  <ListItem
                    key={key}
                    sx={[
                      {
                        p: 0,
                        mb: "8px",
                        borderRadius: 2,
                        overflow: "visible",
                        transition: "all 0.2s",
                        display: "flex",
                        alignItems: "stretch",
                      },
                      ({ palette: { mode, primary } }) => {
                        const bgcolor =
                          mode === "light" ? "#ffffff" : "#24252f";
                        const hoverColor =
                          mode === "light"
                            ? alpha(primary.main, 0.1)
                            : alpha(primary.main, 0.2);

                        return {
                          backgroundColor: bgcolor,
                          "&:hover": {
                            backgroundColor: hoverColor,
                            borderColor: alpha(primary.main, 0.3),
                          },
                        };
                      },
                    ]}
                  >
                    <ListItemText
                      sx={{ px: 2, py: 1, flex: "1 1 0", minWidth: 0 }}
                      primary={
                        <Box
                          sx={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <Typography
                            variant="subtitle1"
                            component="div"
                            noWrap
                            title={key}
                            sx={{ display: "flex", alignItems: "center" }}
                          >
                            <span style={{ marginRight: "8px" }}>{key}</span>
                            <TypeBox component="span">
                              {provider.ruleCount}
                            </TypeBox>
                          </Typography>

                          <Typography
                            variant="body2"
                            color="text.secondary"
                            noWrap
                          >
                            <small>{t("shared.labels.updateAt")}: </small>
                            {time.fromNow()}
                          </Typography>
                        </Box>
                      }
                      secondary={
                        <Box sx={{ display: "flex" }}>
                          <TypeBox component="span">
                            {provider.vehicleType}
                          </TypeBox>
                          <TypeBox component="span">
                            {provider.behavior}
                          </TypeBox>
                        </Box>
                      }
                    />
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                        flexShrink: 0,
                        pr: 1,
                      }}
                    >
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={!providerUrl}
                        onClick={() => providerUrl && openWebUrl(providerUrl)}
                        startIcon={<OpenInNewRounded fontSize="small" />}
                        sx={{ minWidth: "auto" }}
                        title={providerUrl ? undefined : ""}
                      >
                        {t("rules.page.provider.actions.openRepo")}
                      </Button>
                      <IconButton
                        size="small"
                        color="primary"
                        onClick={() => updateProvider(key)}
                        disabled={isUpdating}
                        aria-label={t("rules.page.provider.actions.update")}
                        sx={{
                          animation: isUpdating
                            ? "spin 1s linear infinite"
                            : "none",
                          "@keyframes spin": {
                            "0%": { transform: "rotate(0deg)" },
                            "100%": { transform: "rotate(360deg)" },
                          },
                        }}
                        title={t("rules.page.provider.actions.update")}
                      >
                        <RefreshRounded />
                      </IconButton>
                    </Box>
                  </ListItem>
                );
              });
            })()}
          </List>
        </DialogContent>

        <DialogActions>
          <Button onClick={handleClose} variant="outlined">
            {t("shared.actions.close")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
