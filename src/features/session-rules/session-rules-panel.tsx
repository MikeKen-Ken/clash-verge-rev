import { DeleteForeverRounded, DeleteOutlineRounded } from "@mui/icons-material";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Typography,
} from "@mui/material";
import { useLockFn } from "ahooks";
import dayjs from "dayjs";

import { showNotice } from "@/services/notice-service";

import { clearSessionRules, removeSessionRule } from "./api";
import { formatPolicyLabel } from "./policy-targets";
import { refreshSessionRules, useSessionRules } from "./use-session-rules";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SessionRulesPanel({ open, onClose }: Props) {
  const { data: rules = [], isLoading } = useSessionRules();

  const onRemove = useLockFn(async (id: string) => {
    try {
      await removeSessionRule(id);
      await refreshSessionRules();
      showNotice.success("Temporary rule deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotice.error(message);
    }
  });

  const onClearAll = useLockFn(async () => {
    try {
      await clearSessionRules();
      await refreshSessionRules();
      showNotice.success("All temporary rules cleared");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotice.error(message);
    }
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        Temporary rules
        <Typography variant="caption" display="block" color="text.secondary">
          Persisted until manually deleted; active only in rule mode
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {isLoading ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Loading…
            </Typography>
          </Box>
        ) : rules.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No temporary rules. Right-click a connection in the connections list to add one.
            </Typography>
          </Box>
        ) : (
          <List disablePadding>
            {rules.map((rule) => (
              <ListItem
                key={rule.id}
                divider
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label="Delete"
                    onClick={() => onRemove(rule.id)}
                  >
                    <DeleteOutlineRounded fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemText
                  primary={`${rule.ruleType}, ${rule.payload} → ${formatPolicyLabel(rule.target)}`}
                  secondary={dayjs(rule.createdAt * 1000).format(
                    "YYYY-MM-DD HH:mm:ss",
                  )}
                  primaryTypographyProps={{
                    fontSize: 13,
                    sx: { wordBreak: "break-all" },
                  }}
                  secondaryTypographyProps={{ fontSize: 11 }}
                />
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button
          color="warning"
          startIcon={<DeleteForeverRounded />}
          disabled={rules.length === 0}
          onClick={onClearAll}
        >
          Clear all
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
