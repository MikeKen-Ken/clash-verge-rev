import { QrCode2 } from "@mui/icons-material";
import { Box, Chip, IconButton } from "@mui/material";
import { forwardRef, Fragment, useImperativeHandle, useState } from "react";
import { useTranslation } from "react-i18next";

import { DialogRef } from "@/components/base";
import { EditorViewer } from "@/components/profile/editor-viewer";
import {
  getRuntimeYaml,
  startRuntimeConfigLanShare,
  stopRuntimeConfigLanShare,
} from "@/services/cmds";
import { showNotice } from "@/services/notice-service";

import { RuntimeLanShareDialog } from "./runtime-lan-share-dialog";

export const ConfigViewer = forwardRef<DialogRef>((_, ref) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState("");
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<RuntimeLanShareInfo | null>(null);

  const shutdownLanShare = async () => {
    await stopRuntimeConfigLanShare().catch(() => {});
  };

  useImperativeHandle(ref, () => ({
    open: () => {
      getRuntimeYaml().then((data) => {
        setRuntimeConfig(data ?? "# Error getting runtime yaml\n");
        setOpen(true);
      });
    },
    close: () => {
      void shutdownLanShare();
      setShareDialogOpen(false);
      setShareInfo(null);
      setOpen(false);
    },
  }));

  const handleViewerClose = async () => {
    await shutdownLanShare();
    setShareDialogOpen(false);
    setShareInfo(null);
    setOpen(false);
  };

  const handleLanQrClick = async () => {
    try {
      const info = await startRuntimeConfigLanShare();
      setShareInfo(info);
      setShareDialogOpen(true);
    } catch (e) {
      showNotice.error(
        "profiles.modals.runtimeShare.startFailed",
        e instanceof Error ? e : new Error(String(e)),
      );
    }
  };

  const handleShareDialogClosed = () => {
    setShareDialogOpen(false);
    setShareInfo(null);
  };

  if (!open) return null;
  return (
    <Fragment>
      <EditorViewer
        open={true}
        title={
          <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
            {t("settings.components.verge.advanced.fields.runtimeConfig")}
            <Chip label={t("shared.labels.readOnly")} size="small" />
            <IconButton
              size="small"
              color="inherit"
              aria-label={t("profiles.modals.runtimeShare.shareActionTitle")}
              title={t("profiles.modals.runtimeShare.shareActionTitle")}
              onClick={() => void handleLanQrClick()}
            >
              <QrCode2 />
            </IconButton>
          </Box>
        }
        initialData={() => Promise.resolve(runtimeConfig)}
        dataKey="runtime-config"
        readOnly
        language="yaml"
        onClose={() => void handleViewerClose()}
      />
      <RuntimeLanShareDialog
        open={shareDialogOpen}
        info={shareInfo}
        onClosed={() => void handleShareDialogClosed()}
      />
    </Fragment>
  );
});
