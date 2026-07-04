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
import { getIpInfo } from "@/services/api";
import { showNotice } from "@/services/notice-service";

const IP_INFO_CACHE_KEY = "cv_ip_info_cache";
const IP_REFRESH_SECONDS = 300;

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
  onCopy,
}: {
  label: string;
  value?: string | null;
  loading?: boolean;
  onCopy?: () => void;
}) => {
  const displayValue = value ?? "—";
  const canCopy = Boolean(value && onCopy);

  return (
    <Tooltip title={canCopy ? `点击复制${label}` : label}>
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
            color="text.primary"
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

export const ProxyPageIpInfo = ({ localIp, mode, refreshToken }: Props) => {
  const { clashConfig } = useAppData();
  const [ipInfo, setIpInfo] = useState<IpInfoData | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchSeqRef = useRef(0);

  const fetchIpInfo = useCallback(
    async (force = false) => {
      const seq = ++fetchSeqRef.current;

      if (!force) {
        try {
          const raw = window.sessionStorage.getItem(IP_INFO_CACHE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as {
              ts?: number;
              data?: IpInfoData & { asn_organization?: string };
            };
            const now = Date.now();
            if (
              parsed?.ts &&
              parsed?.data?.ip &&
              now - parsed.ts < IP_REFRESH_SECONDS * 1000
            ) {
              setIpInfo({
                ip: parsed.data.ip,
                country_code: parsed.data.country_code || "",
                country: parsed.data.country || "",
                region: parsed.data.region || "",
                city: parsed.data.city || "",
                isp: parsed.data.isp || parsed.data.asn_organization || "",
              });
              setLoading(false);
              return;
            }
          }
        } catch {
          // ignore
        }
      }

      if (!clashConfig) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const data = await getIpInfo();
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
      } catch {
        if (seq !== fetchSeqRef.current) return;
        setIpInfo(null);
      } finally {
        if (seq === fetchSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [clashConfig],
  );

  useEffect(() => {
    void fetchIpInfo(true);
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
