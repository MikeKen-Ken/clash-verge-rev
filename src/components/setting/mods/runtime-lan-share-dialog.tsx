import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  Typography,
} from "@mui/material";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import QRCode from "react-qr-code";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { stopRuntimeConfigLanShare } from "@/services/cmds";
import { showNotice } from "@/services/notice-service";

type Props = {
  open: boolean;
  info: RuntimeLanShareInfo | null;
  onClosed: () => void;
};

/** Dialog that shows QR + LAN URLs for importing runtime YAML as an HTTP URL profile. */
export function RuntimeLanShareDialog({ open, info, onClosed }: Props) {
  const { t } = useTranslation();
  const [consumed, setConsumed] = useState(false);

  useEffect(() => {
    if (!open || !info?.primaryUrl) {
      setConsumed(false);
      return;
    }

    let unlisten: UnlistenFn | null = null;
    let active = true;

    void listen("verge://runtime-lan-share-consumed", () => {
      if (active) setConsumed(true);
    }).then((fn) => {
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [open, info?.primaryUrl]);

  const finishClose = async () => {
    await stopRuntimeConfigLanShare().catch(() => { });
    onClosed();
  };

  const minutes = info ? Math.max(1, Math.round(info.ttlSecs / 60)) : 0;

  const handleCopyPrimary = async () => {
    if (!info?.primaryUrl || consumed) return;
    try {
      await writeText(info.primaryUrl);
      showNotice.success(t("profiles.modals.runtimeShare.copyDone"));
    } catch (e) {
      showNotice.error(
        "profiles.modals.runtimeShare.startFailed",
        e instanceof Error ? e : new Error(String(e)),
      );
    }
  };

  return (
    <Dialog open={open} onClose={() => void finishClose()} maxWidth="sm" fullWidth>
      <DialogTitle>{t("profiles.modals.runtimeShare.title")}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t("profiles.modals.runtimeShare.hint")}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t("profiles.modals.runtimeShare.firewall")}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t("profiles.modals.runtimeShare.cleartext")}
        </Typography>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {t("profiles.modals.runtimeShare.ttl", { minutes })}
        </Typography>
        {consumed ? (
          <Typography variant="body2" color="warning.main" sx={{ mb: 2 }}>
            {t("profiles.modals.runtimeShare.consumedNotice", {
              defaultValue: "This QR code has expired after first scan.",
            })}
          </Typography>
        ) : null}

        {info?.primaryUrl ? (
          <>
            <Box
              display="flex"
              justifyContent="center"
              sx={{
                mb: 2,
                p: 2,
                bgcolor: "background.paper",
                transition: "filter 0.2s ease, opacity 0.2s ease",
                filter: consumed ? "blur(4px)" : "none",
                opacity: consumed ? 0.6 : 1,
              }}
            >
              <QRCode value={info.primaryUrl} size={220} fgColor="#111111" bgColor="#ffffff" />
            </Box>
            <Typography
              variant="caption"
              sx={{
                wordBreak: "break-all",
                display: "block",
                mb: 2,
                transition: "filter 0.2s ease, opacity 0.2s ease",
                filter: consumed ? "blur(2px)" : "none",
                opacity: consumed ? 0.7 : 1,
              }}
            >
              {info.primaryUrl}
            </Typography>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t("profiles.modals.runtimeShare.candidateUrls")}
            </Typography>
            <List dense disablePadding sx={{ mb: 2 }}>
              {info.urls.map((u) => (
                <ListItem key={u} disablePadding sx={{ py: 0.25 }}>
                  <Typography variant="caption" sx={{ wordBreak: "break-all" }}>
                    {u}
                  </Typography>
                </ListItem>
              ))}
            </List>
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => void handleCopyPrimary()}
          disabled={!info?.primaryUrl || consumed}
        >
          {t("profiles.modals.runtimeShare.copyPrimary")}
        </Button>
        <Button variant="contained" onClick={() => void finishClose()}>
          {t("profiles.modals.runtimeShare.stopSharing")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
