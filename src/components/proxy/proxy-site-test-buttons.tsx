import {
  Box,
  CircularProgress,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import NetworkCheckRounded from "@mui/icons-material/NetworkCheckRounded";
import { useLockFn } from "ahooks";
import { useState } from "react";

import baiduIcon from "@/assets/image/test/baidu.svg?raw";
import googleIcon from "@/assets/image/test/google.svg?raw";
import delayManager, {
  checkProxyDelayForUrl,
  DEFAULT_GROUP_TIMEOUT_MS,
  getGroupDelayTimeout,
} from "@/services/delay";
import { showNotice } from "@/services/notice-service";

const SITE_TESTS = [
  {
    id: "baidu",
    name: "百度",
    url: "https://www.baidu.com",
    icon: baiduIcon,
  },
  {
    id: "google",
    name: "Google",
    url: "https://www.google.com",
    icon: googleIcon,
  },
] as const;

type SiteId = (typeof SITE_TESTS)[number]["id"];
type DelayState = -1 | -2 | number;

export interface ProxySiteTestSelection {
  groupName: string;
  proxyName: string;
  isManualSelection?: boolean;
  group?: { timeout?: number; selectedTimeout?: number } | null;
}

interface Props {
  mode: string;
  selection: ProxySiteTestSelection | null;
}

const renderSiteIcon = (icon: string, name: string) => (
  <img
    src={`data:image/svg+xml;base64,${btoa(icon)}`}
    alt={name}
    width={16}
    height={16}
    style={{ display: "block", flexShrink: 0 }}
  />
);

const UNTESTABLE_MODES = new Set(["direct", "offline"]);
const SKIP_PROXY_NAMES = new Set(["DIRECT", "REJECT"]);

export const ProxySiteTestButtons = ({ mode, selection }: Props) => {
  const [delays, setDelays] = useState<Record<SiteId, DelayState>>({
    baidu: -1,
    google: -1,
  });
  const [testingId, setTestingId] = useState<SiteId | null>(null);

  const canTest =
    !UNTESTABLE_MODES.has(mode) &&
    selection != null &&
    !SKIP_PROXY_NAMES.has(selection.proxyName);

  const timeout = selection
    ? getGroupDelayTimeout(selection.group, selection.isManualSelection ?? false)
    : DEFAULT_GROUP_TIMEOUT_MS;

  const runTest = useLockFn(async (id: SiteId, url: string) => {
    if (!selection || !canTest) {
      showNotice.error("当前没有可用节点，请等待 Fallback 测速完成或手动选择节点");
      return;
    }

    setTestingId(id);
    setDelays((prev) => ({ ...prev, [id]: -2 }));
    try {
      const delay = await checkProxyDelayForUrl(
        selection.proxyName,
        url,
        timeout,
      );
      setDelays((prev) => ({ ...prev, [id]: delay }));
    } catch {
      setDelays((prev) => ({ ...prev, [id]: 1e6 }));
    } finally {
      setTestingId(null);
    }
  });

  const selectionHint = selection
    ? `${selection.groupName} → ${selection.proxyName}${
        selection.isManualSelection ? "（手动）" : "（自动）"
      }`
    : "暂无可用节点";

  const buildTooltip = (siteName: string, url: string) => {
    if (mode === "direct" || mode === "offline") {
      return "直连/离线模式下不可用，请切换为规则或全局模式";
    }
    if (!canTest) {
      return `当前无法测试：${selectionHint}。请等待 Fallback/URLTest 组测速完成，或手动选择节点。`;
    }
    return `经 ${selectionHint} 测试访问 ${siteName}\n${url}\n点击图标开始测速`;
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
      {SITE_TESTS.map(({ id, name, url, icon }) => {
        const delay = delays[id];
        const isTesting = delay === -2;
        const delayLabel =
          delay === -1
            ? null
            : isTesting
              ? null
              : delayManager.formatDelay(delay, timeout);
        const delayColor = delayManager.formatDelayColor(delay, timeout);

        return (
          <Tooltip key={id} title={buildTooltip(name, url)}>
            <span>
              <IconButton
                size="small"
                disabled={!canTest || testingId !== null}
                onClick={() => runTest(id, url)}
                aria-label={`测试 ${name}`}
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  width: 52,
                  height: 28,
                  gap: 0.25,
                  flexShrink: 0,
                }}
              >
                {renderSiteIcon(icon, name)}
                {isTesting ? (
                  <CircularProgress size={12} />
                ) : delay === -1 ? (
                  <NetworkCheckRounded sx={{ fontSize: 14, color: "text.secondary" }} />
                ) : (
                  <Typography
                    variant="caption"
                    component="span"
                    sx={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      lineHeight: 1,
                      color: delayColor || "text.secondary",
                      minWidth: 16,
                      textAlign: "center",
                    }}
                  >
                    {delayLabel}
                  </Typography>
                )}
              </IconButton>
            </span>
          </Tooltip>
        );
      })}
    </Box>
  );
};
