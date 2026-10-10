import { Box, Typography } from "@mui/material";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CONNECTIVITY_MERGE_STATUS_EVENT,
  connectivityLastSyncAt,
  connectivityMergeStatus,
  type ConnectivityMergeStatus,
} from "@/services/cmds";

const KEY = "proxies.page.connectivityStats";

function formatMergeTime(unixMillis: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixMillis));
}

type Props = {
  active: boolean;
  /** Called when any merge (manual or automatic) finishes while the panel is open. */
  onFinished: () => void;
};

export const ConnectivityMergeStatusText = ({ active, onFinished }: Props) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ConnectivityMergeStatus | null>(null);
  const [lastMergeAt, setLastMergeAt] = useState(0);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const refreshLastMerge = () =>
      connectivityLastSyncAt()
        .then((value) => {
          if (!disposed) setLastMergeAt(value);
        })
        .catch(() => {});
    void connectivityMergeStatus()
      .then((value) => {
        if (!disposed) setStatus(value);
      })
      .catch(() => {});
    void refreshLastMerge();
    void listen<ConnectivityMergeStatus>(
      CONNECTIVITY_MERGE_STATUS_EVENT,
      ({ payload }) => {
        setStatus(payload);
        if (payload.phase !== "running") {
          void refreshLastMerge();
          onFinishedRef.current();
        }
      },
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active]);

  const lines: Array<{ text: string; color: string }> = [];
  const secondary = "text.secondary";
  const phase = status?.phase ?? "idle";
  const finishedAt = status?.finishedAt ?? 0;

  if (phase === "running") {
    lines.push({
      text: t(`${KEY}.mergeRunning`, { progress: status?.progress ?? 0 }),
      color: "primary.main",
    });
  } else if (phase === "failed" && finishedAt > 0) {
    lines.push({
      text: t(`${KEY}.mergeFailedAt`, {
        time: formatMergeTime(finishedAt),
        error: status?.error ?? "",
      }),
      color: "error.main",
    });
  } else if ((phase === "success" || phase === "partial") && finishedAt > 0) {
    lines.push({
      text:
        phase === "success"
          ? t(`${KEY}.mergeSuccess`, { time: formatMergeTime(finishedAt) })
          : t(`${KEY}.mergePartial`, {
              time: formatMergeTime(finishedAt),
              count: status?.skipped.length ?? 0,
            }),
      color: phase === "success" ? "success.main" : "warning.main",
    });
  }

  if (phase === "idle" || phase === "failed" || phase === "running") {
    lines.push({
      text:
        lastMergeAt > 0
          ? t(`${KEY}.lastMerge`, { time: formatMergeTime(lastMergeAt) })
          : t(`${KEY}.lastMergeNever`),
      color: secondary,
    });
  }

  if (phase === "success" || phase === "partial") {
    const pulled = status?.pulled ?? [];
    if (pulled.length === 0) {
      lines.push({ text: t(`${KEY}.mergeNoDevices`), color: "warning.main" });
    }
    for (const device of pulled) {
      lines.push({
        text: t(`${KEY}.mergePulled`, {
          device: device.device,
          time: formatMergeTime(device.updatedAt),
          count: device.proxyCount,
        }),
        color: secondary,
      });
    }
    for (const skipped of status?.skipped ?? []) {
      lines.push({
        text: t(`${KEY}.mergeSkipped`, { device: skipped }),
        color: "warning.main",
      });
    }
  }

  return (
    <Box sx={{ width: "100%" }}>
      {lines.map((line, index) => (
        <Typography key={index} variant="body2" color={line.color}>
          {line.text}
        </Typography>
      ))}
    </Box>
  );
};
