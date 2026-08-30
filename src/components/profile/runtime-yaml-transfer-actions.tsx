import { FileDownloadOutlined, FileUploadOutlined } from "@mui/icons-material";
import { IconButton, Tooltip } from "@mui/material";
import { useLockFn } from "ahooks";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmViewer } from "@/components/profile/confirm-viewer";
import { useVerge } from "@/hooks/use-verge";
import {
  exportRuntimeYamlWebdav,
  importRuntimeYamlFromWebdav,
} from "@/services/cmds";
import { showNotice } from "@/services/notice-service";
import {
  isHttpsWebdavUrl,
  isWebdavConfigured,
} from "@/services/webdav-status";

type TransferAction = "upload" | "download";

interface Props {
  onImported: () => void | Promise<void>;
}

export const RuntimeYamlTransferActions = ({ onImported }: Props) => {
  const { t } = useTranslation();
  const { verge } = useVerge();
  const [pendingAction, setPendingAction] = useState<TransferAction | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const uploadRuntimeYaml = async () => {
    await importRuntimeYamlFromWebdav();
    await onImported();
    showNotice.success("profiles.modals.runtimeTransfer.uploadSucceeded");
  };

  const downloadRuntimeYaml = async () => {
    await exportRuntimeYamlWebdav();
    showNotice.success("profiles.modals.runtimeTransfer.downloadSucceeded");
  };

  const requestTransfer = (action: TransferAction) => {
    if (!isWebdavConfigured(verge)) {
      showNotice.error(t("profiles.modals.runtimeTransfer.webdavRequired"));
      return;
    }
    if (!isHttpsWebdavUrl(verge?.webdav_url)) {
      showNotice.error(t("profiles.modals.runtimeTransfer.httpsRequired"));
      return;
    }
    setPendingAction(action);
  };

  const confirmTransfer = useLockFn(async () => {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;

    setBusy(true);
    try {
      if (action === "upload") {
        await uploadRuntimeYaml();
      } else {
        await downloadRuntimeYaml();
      }
    } catch (error) {
      console.error(`[RuntimeYamlTransfer] ${action} failed`, error);
      showNotice.error(
        error instanceof Error
          ? error.message
          : t("profiles.modals.runtimeTransfer.failed"),
      );
    } finally {
      setBusy(false);
    }
  });

  const isUpload = pendingAction === "upload";

  return (
    <Fragment>
      <Tooltip title={t("profiles.modals.runtimeTransfer.actions.upload")}>
        <span>
          <IconButton
            size="small"
            color="inherit"
            disabled={busy}
            aria-label={t("profiles.modals.runtimeTransfer.actions.upload")}
            onClick={() => requestTransfer("upload")}
          >
            <FileUploadOutlined />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t("profiles.modals.runtimeTransfer.actions.download")}>
        <span>
          <IconButton
            size="small"
            color="inherit"
            disabled={busy}
            aria-label={t("profiles.modals.runtimeTransfer.actions.download")}
            onClick={() => requestTransfer("download")}
          >
            <FileDownloadOutlined />
          </IconButton>
        </span>
      </Tooltip>
      <ConfirmViewer
        open={pendingAction !== null}
        title={t(
          isUpload
            ? "profiles.modals.runtimeTransfer.confirmUploadTitle"
            : "profiles.modals.runtimeTransfer.confirmDownloadTitle",
        )}
        message={t(
          isUpload
            ? "profiles.modals.runtimeTransfer.confirmUploadMessage"
            : "profiles.modals.runtimeTransfer.confirmDownloadMessage",
        )}
        onClose={() => setPendingAction(null)}
        onConfirm={() => void confirmTransfer()}
      />
    </Fragment>
  );
};
