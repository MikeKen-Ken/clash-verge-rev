import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import useSWR from "swr";
import { useVisibility } from "@/hooks/use-visibility";
import { recoveryLabels, sanitizeNetworkHealth } from "@/utils/network-health";

export function NetworkHealthPanel() {
  const [open, setOpen] = useState(false);
  const visible = useVisibility();
  const { data, error, isValidating, mutate } = useSWR(
    open && visible ? "networkHealth" : null,
    async () => {
      const raw = await invoke<unknown>("get_network_diagnostics");
      return raw == null ? null : sanitizeNetworkHealth(raw);
    },
    { refreshInterval: 0, shouldRetryOnError: false },
  );
  const report = error ? undefined : data;
  const displayTime = (value?: string) =>
    value ? new Date(value).toLocaleString() : "No observation yet";
  return (
    <>
      <Button onClick={() => setOpen(true)}>Connection health</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Connection health</DialogTitle>
        <DialogContent>
          <Alert severity="info">
            Recovery events describe attempts, not restored connectivity.
            Traffic evidence is a received reply, not a guarantee that every
            destination works. Counters reset when the core restarts.
          </Alert>
          {error ? (
            <Alert severity="warning">
              Health data unavailable. Start the core and refresh.
            </Alert>
          ) : data === null ? (
            <Alert severity="warning">
              This core does not support recovery diagnostics.
            </Alert>
          ) : !data ? (
            <Typography>Reading connection health…</Typography>
          ) : (
            <Box sx={{ mt: 2 }}>
              <Typography>Observed: {displayTime(data.observedAt)}</Typography>
              <Typography>
                Last observed application reply:{" "}
                {displayTime(data.lastTrafficAt)}
              </Typography>
              <Typography>
                Switches: {data.switches} · Failed searches:{" "}
                {data.failedSearches} · Traffic vetoes: {data.trafficVetoes}
              </Typography>
              {[...data.events].reverse().map((event, index) => (
                <Typography key={index} sx={{ mt: 1 }}>
                  {displayTime(event.at)} · {recoveryLabels[event.action]}
                </Typography>
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={!report || isValidating}
            onClick={() => {
              if (!report) return;
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(report, null, 2)], {
                  type: "application/json",
                }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "connection-health.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export report
          </Button>
          <Button disabled={isValidating} onClick={() => void mutate()}>
            Refresh
          </Button>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
