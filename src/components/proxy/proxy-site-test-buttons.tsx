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
import githubIcon from "@/assets/image/test/github.svg?raw";
import googleIcon from "@/assets/image/test/google.svg?raw";
import { cmdTestDelay } from "@/services/cmds";
import delayManager from "@/services/delay";

const SITE_TESTS = [
  {
    id: "baidu",
    name: "百度",
    url: "https://www.baidu.com",
    icon: baiduIcon,
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://www.github.com",
    icon: githubIcon,
  },
  {
    id: "google",
    name: "Google",
    url: "https://www.google.com",
    icon: googleIcon,
  },
] as const;

/** 与后端 test_delay 请求超时一致（秒） */
const SITE_TEST_TIMEOUT_MS = 10_000;

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

const MODE_HINT: Record<string, string> = {
  rule: "规则模式：由配置规则决定出站（如国内站直连、国外站走代理）",
  global: "全局模式：全部流量走当前全局节点",
  direct: "直连模式：全部流量直连",
  offline: "离线模式：规则为 MATCH,REJECT，测速结果预期失败",
};

const renderSiteIcon = (icon: string, name: string) => (
  <img
    src={`data:image/svg+xml;base64,${btoa(icon)}`}
    alt={name}
    width={14}
    height={14}
    style={{ display: "block", flexShrink: 0 }}
  />
);

const initialDelays = (): Record<SiteId, DelayState> => ({
  baidu: -1,
  github: -1,
  google: -1,
});

export const ProxySiteTestButtons = ({ mode, selection }: Props) => {
  const [delays, setDelays] = useState<Record<SiteId, DelayState>>(initialDelays);
  const [testing, setTesting] = useState(false);
  const hasStarted = SITE_TESTS.some(({ id }) => delays[id] !== -1);

  const runAllTests = useLockFn(async () => {
    setTesting(true);
    setDelays(
      Object.fromEntries(SITE_TESTS.map(({ id }) => [id, -2])) as Record<
        SiteId,
        DelayState
      >,
    );

    const results = await Promise.all(
      SITE_TESTS.map(async ({ id, url }) => {
        try {
          const delay = await cmdTestDelay(url);
          return { id, delay };
        } catch {
          return { id, delay: 1e6 as DelayState };
        }
      }),
    );

    setDelays((prev) => {
      const next = { ...prev };
      for (const { id, delay } of results) {
        next[id] = delay;
      }
      return next;
    });
    setTesting(false);
  });

  const selectionHint = selection
    ? `${selection.groupName} → ${selection.proxyName}${
        selection.isManualSelection ? "（手动）" : "（自动）"
      }`
    : null;

  const buildTooltip = () => {
    const modeHint = MODE_HINT[mode] ?? `当前模式：${mode}`;
    const globalNode =
      mode === "global" && selectionHint
        ? `\n当前全局节点：${selectionHint}`
        : "";
    const sites = SITE_TESTS.map(({ name, url }) => `${name}（${url}）`).join(
      "\n",
    );
    return `${modeHint}\n同时测试：\n${sites}${globalNode}\n点击开始测速`;
  };

  return (
    <Tooltip title={buildTooltip()}>
      <span>
        <IconButton
          size="small"
          disabled={testing}
          onClick={runAllTests}
          aria-label="站点连通性测速"
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            height: 28,
            px: 0.5,
            gap: 0.75,
            flexShrink: 0,
          }}
        >
          {!hasStarted ? (
            <NetworkCheckRounded sx={{ fontSize: 16, color: "text.secondary" }} />
          ) : (
            SITE_TESTS.map(({ id, name, icon }) => {
              const delay = delays[id];
              const isTesting = delay === -2;
              const delayLabel = isTesting
                ? null
                : delayManager.formatDelay(delay, SITE_TEST_TIMEOUT_MS);
              const delayColor = delayManager.formatDelayColor(
                delay,
                SITE_TEST_TIMEOUT_MS,
              );

              return (
                <Box
                  key={id}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.25,
                    minWidth: 0,
                  }}
                >
                  {renderSiteIcon(icon, name)}
                  {isTesting ? (
                    <CircularProgress size={10} />
                  ) : (
                    <Typography
                      variant="caption"
                      component="span"
                      sx={{
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        lineHeight: 1,
                        fontSize: 10,
                        color: delayColor || "text.secondary",
                        minWidth: 14,
                        textAlign: "center",
                      }}
                    >
                      {delayLabel}
                    </Typography>
                  )}
                </Box>
              );
            })
          )}
        </IconButton>
      </span>
    </Tooltip>
  );
};
