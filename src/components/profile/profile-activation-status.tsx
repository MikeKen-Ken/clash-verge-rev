import { Alert, Button } from "@mui/material";
import { useState } from "react";
import useSWR from "swr";
import { useVisibility } from "@/hooks/use-visibility";
import { useProfiles } from "@/hooks/use-profiles";
import {
  getProfileActivation,
  retryProfileActivation,
} from "@/services/profile-activation";
import { showNotice } from "@/services/notice-service";

export function ProfileActivationStatus() {
  const visible = useVisibility();
  const { current } = useProfiles();
  const [busy, setBusy] = useState(false);
  const { data, error } = useSWR(
    visible ? "profileActivation" : null,
    getProfileActivation,
    {
      refreshInterval: visible ? 5000 : 0,
    },
  );
  if (error)
    return <Alert severity="warning">Activation status unavailable.</Alert>;
  if (!data || data.uid !== current?.uid) return null;
  const pending =
    data.outcome === "activationFailed" || data.outcome === "downloadSucceeded";
  return (
    <Alert
      severity={pending ? "warning" : "info"}
      sx={{ mb: 1 }}
      action={
        pending ? (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await retryProfileActivation(data.uid);
              } catch (err) {
                showNotice.error(String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry activation
          </Button>
        ) : undefined
      }
    >
      {current.name || "Current profile"}:{" "}
      {pending
        ? "Current subscription downloaded; activation is pending. The new download is not confirmed active."
        : "The last subscription activation for the current profile succeeded."}
      {data.lastAppliedAt != null &&
        ` Last confirmed activation: ${new Date(data.lastAppliedAt).toLocaleString()}.`}
    </Alert>
  );
}
