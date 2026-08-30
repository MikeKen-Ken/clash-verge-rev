import { FileDownloadOutlined, FileUploadOutlined } from "@mui/icons-material";
import { IconButton, Tooltip } from "@mui/material";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useLockFn } from "ahooks";
import dayjs from "dayjs";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmViewer } from "@/components/profile/confirm-viewer";
import {
  exportTextFile,
  getRuntimeYaml,
  importRuntimeYamlProfile,
} from "@/services/cmds";
import { showNotice } from "@/services/notice-service";

type TransferAction = "upload" | "download";

interface Props {
  onImported: () => void | Promise<void>;
}

const yamlFilters = [{ name: "YAML", extensions: ["yaml", "yml"] }];

const profileNameFromPath = (path: string) => {
  const fileName = path.split(/[/\\]/).pop() || "Imported runtime YAML";
  return fileName.replace(/\.ya?ml$/i, "").trim() || "Imported runtime YAML";
};

export const RuntimeYamlTransferActions = ({ onImported }: Props) => {
  const { t } = useTranslation();
  const [pendingAction, setPendingAction] = useState<TransferAction | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const uploadRuntimeYaml = async () => {
    const source = await open({
      title: t("profiles.modals.runtimeTransfer.uploadPickerTitle"),
      multiple: false,
      filters: yamlFilters,
    });
    if (!source || Array.isArray(source)) return;

    await importRuntimeYamlProfile(profileNameFromPath(source), source);
    await onImported();
    showNotice.success("profiles.modals.runtimeTransfer.uploadSucceeded");
  };

  const downloadRuntimeYaml = async () => {
    const destination = await save({
      title: t("profiles.modals.runtimeTransfer.downloadPickerTitle"),
      defaultPath: `runtime-${dayjs().format("YYYY-MM-DD_HH-mm-ss")}.yaml`,
      filters: yamlFilters,
    });
    if (!destination || Array.isArray(destination)) return;

    const content = await getRuntimeYaml();
    if (!content?.trim()) {
      throw new Error(t("profiles.modals.runtimeTransfer.runtimeUnavailable"));
    }
    await exportTextFile(destination, content);
    showNotice.success("profiles.modals.runtimeTransfer.downloadSucceeded");
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
            onClick={() => setPendingAction("upload")}
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
            onClick={() => setPendingAction("download")}
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
