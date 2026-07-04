import {
  alpha,
  Box,
  CircularProgress,
  Tooltip,
  Typography,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppData } from "@/providers/app-data-context";
import { useClash } from "@/hooks/use-clash";
import { useVerge } from "@/hooks/use-verge";
import { getIpInfo } from "@/services/api";
import { showNotice } from "@/services/notice-service";

const IP_INFO_CACHE_KEY = "cv_ip_info_cache";
const IP_REFRESH_SECONDS = 300;
const FETCH_SAFETY_TIMEOUT_MS = 18000;

interface IpInfoData {
  ip: string;
  country_code: string;
  country: string;
  region: string;
  city: string;
  isp: string;
}

interface Props {
  localIp?: string;
  /** 代理模式变化时重新检测出口 IP */
  mode: string;
  /** 与页面刷新按钮联动 */
  refreshToken: number;
}

const getCountryFlag = (countryCode: string) => {
  if (!countryCode) return "";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
};

const cardSx = {
  ml: 0.5,
  px: 1,
  py: 0.5,
  borderRadius: 1,
  bgcolor: (theme: { palette: { divider: string } }) =>
    alpha(theme.palette.divider, 0.08),
  border: (theme: { palette: { divider: string } }) =>
    `1px solid ${alpha(theme.palette.divider, 0.2)}`,
  minWidth: 160,
};

const IpRow = ({
  label,
  value,
  loading,
  error,
  onCopy,
}: {
  label: string;
  value?: string | null;
  loading?: boolean;
  error?: string;
  onCopy?: () => void;
}) => {
  const displayValue = loading ? null : value ?? (error ? "检测失败" : "—");
  const canCopy = Boolean(value && onCopy);
  const tooltip = error
    ? error
    : canCopy
      ? `点击复制${label}`
      : label;

  return (
    <Tooltip title={tooltip}>
      <Box
        role={canCopy ? "button" : undefined}
        tabIndex={canCopy ? 0 : undefined}
        onClick={() => {
          if (canCopy) onCopy?.();
        }}
        onKeyDown={(event) => {
          if (!canCopy) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onCopy?.();
          }
        }}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          cursor: canCopy ? "pointer" : "default",
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: 44 }}
        >
          {label}
        </Typography>
        {loading ? (
          <CircularProgress size={14} />
        ) : (
          <Typography
            variant="body2"
            color={error ? "error.main" : "text.primary"}
            sx={{
              fontFamily: "monospace",
              fontVariantNumeric: "tabular-nums",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {displayValue}
          </Typography>
        )}
      </Box>
    </Tooltip>
  );
};

const readCachedIpInfo = (): IpInfoData | null => {
  try {
    const raw = window.sessionStorage.getItem(IP_INFO_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts?: number;
      data?: IpInfoData & { asn_organization?: string };
    };
    const now = Date.now();
    if (
      !parsed?.ts ||
      !parsed?.data?.ip ||
      now - parsed.ts >= IP_REFRESH_SECONDS * 1000
    ) {
      return null;
    }
    return {
      ip: parsed.data.ip,
      country_code: parsed.data.country_code || "",
      country: parsed.data.country || "",
      region: parsed.data.region || "",
      city: parsed.data.city || "",
      isp: parsed.data.isp || parsed.data.asn_organization || "",
    };
  } catch {
    return null;
  }
};

export const ProxyPageIpInfo = ({ localIp, mode, refreshToken }: Props) => {
  const { clashConfig } = useAppData();
  const { clash } = useClash();
  const { verge } = useVerge();
  const [ipInfo, setIpInfo] = useState<IpInfoData | null>(() =>
    readCachedIpInfo(),
  );
  const [loading, setLoading] = useState(() => !readCachedIpInfo());
  const [fetchError, setFetchError] = useState("");
  const fetchSeqRef = useRef(0);
  const prevModeRef = useRef(mode);
  const prevRefreshTokenRef = useRef(refreshToken);

  const fetchIpInfo = useCallback(
    async (force = false) => {
      const seq = ++fetchSeqRef.current;
      setFetchError("");

      if (mode === "offline") {
        setIpInfo(null);
        setLoading(false);
        return;
      }

      if (mode === "direct" && localIp) {
        setIpInfo({
          ip: localIp,
          country_code: "",
          country: "",
          region: "",
          city: "",
          isp: "",
        });
        setLoading(false);
        return;
      }

      if (!force) {
        const cached = readCachedIpInfo();
        if (cached) {
          setIpInfo(cached);
          setLoading(false);
          return;
        }
      }

      if (!clashConfig) {
        setLoading(false);
        return;
      }

      setLoading(true);
      const safetyTimer = window.setTimeout(() => {
        if (seq !== fetchSeqRef.current) return;
        setLoading(false);
        setFetchError("出口 IP 检测超时，请确认核心已启动且代理可用");
      }, FETCH_SAFETY_TIMEOUT_MS);

      try {
        const mixedPort =
          clashConfig?.mixedPort ??
          clash?.["mixed-port"] ??
          verge?.verge_mixed_port;
        const data = await getIpInfo(mixedPort);
        if (seq !== fetchSeqRef.current) return;
        const next: IpInfoData = {
          ip: data.ip || "",
          country_code: data.country_code || "",
          country: data.country || "",
          region: data.region || "",
          city: data.city || "",
          isp: data.asn_organization || "",
        };
        setIpInfo(next);
        try {
          window.sessionStorage.setItem(
            IP_INFO_CACHE_KEY,
            JSON.stringify({ data, ts: Date.now() }),
          );
        } catch {
          // ignore
        }
      } catch (err) {
        if (seq !== fetchSeqRef.current) return;
        setIpInfo(null);
        const message =
          err instanceof Error ? err.message : "出口 IP 检测失败";
        setFetchError(`${message}。请确认核心已启动且当前模式可正常出站。`);
      } finally {
        window.clearTimeout(safetyTimer);
        if (seq === fetchSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [clashConfig, clash, verge?.verge_mixed_port, localIp, mode],
  );

  useEffect(() => {
    const force =
      prevModeRef.current !== mode ||
      prevRefreshTokenRef.current !== refreshToken;
    prevModeRef.current = mode;
    prevRefreshTokenRef.current = refreshToken;
    void fetchIpInfo(force);
  }, [fetchIpInfo, mode, refreshToken]);

  const handleCopy = useLockFn(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showNotice.success("shared.feedback.notifications.common.copySuccess");
    } catch (err) {
      showNotice.error("settings.sections.externalController.messages.copyFailed", err);
    }
  });

  const locationText = [ipInfo?.country, ipInfo?.city, ipInfo?.region]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box sx={{ ...cardSx, display: "flex", flexDirection: "column", gap: 0.25 }}>
      <IpRow
        label="本机 IP"
        value={localIp}
        onCopy={localIp ? () => void handleCopy(localIp) : undefined}
      />
      <IpRow
        label="出口 IP"
        value={ipInfo?.ip}
        loading={loading}
        error={fetchError}
        onCopy={ipInfo?.ip ? () => void handleCopy(ipInfo.ip) : undefined}
      />
      {!loading && ipInfo && (locationText || ipInfo.isp) && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, pl: 0.25 }}>
          {ipInfo.country_code && (
            <Box
              component="span"
              sx={{
                fontSize: "0.875rem",
                lineHeight: 1,
                flexShrink: 0,
                fontFamily: '"twemoji mozilla", sans-serif',
              }}
            >
              {getCountryFlag(ipInfo.country_code)}
            </Box>
          )}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {[locationText, ipInfo.isp].filter(Boolean).join(" · ")}
          </Typography>
        </Box>
      )}
    </Box>
  );
};
