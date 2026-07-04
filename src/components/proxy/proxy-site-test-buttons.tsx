import { Box, Button, CircularProgress, Tooltip, Typography } from "@mui/material";
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
    width={18}
    height={18}
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
      showNotice.error("请先选择一个可用代理节点");
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
    ? `${selection.groupName} → ${selection.proxyName}`
    : "未选择节点";

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
      {SITE_TESTS.map(({ id, name, url, icon }) => {
        const delay = delays[id];
        const isTesting = delay === -2;
        const delayLabel =
          delay === -1
            ? "测试"
            : isTesting
              ? null
              : delayManager.formatDelay(delay, timeout);
        const delayColor = delayManager.formatDelayColor(delay, timeout);

        return (
          <Tooltip
            key={id}
            title={
              canTest
                ? `经当前节点 ${selectionHint} 测试 ${name}`
                : mode === "direct" || mode === "offline"
                  ? "直连/离线模式下请切换为规则或全局模式"
                  : `当前无法测试（${selectionHint}）`
            }
          >
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled={!canTest || testingId !== null}
                onClick={() => runTest(id, url)}
                sx={{
                  minWidth: "auto",
                  px: 1,
                  py: 0.25,
                  gap: 0.75,
                  whiteSpace: "nowrap",
                }}
              >
                {renderSiteIcon(icon, name)}
                <Typography variant="body2" component="span">
                  {name}
                </Typography>
                {isTesting ? (
                  <CircularProgress size={14} />
                ) : (
                  <Typography
                    variant="body2"
                    component="span"
                    sx={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      color: delayColor || "text.secondary",
                      minWidth: 20,
                      textAlign: "right",
                    }}
                  >
                    {delayLabel}
                  </Typography>
                )}
              </Button>
            </span>
          </Tooltip>
        );
      })}
    </Box>
  );
};
