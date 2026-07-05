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
      showNotice.success("已删除临时规则");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotice.error(message);
    }
  });

  const onClearAll = useLockFn(async () => {
    try {
      await clearSessionRules();
      await refreshSessionRules();
      showNotice.success("已清空全部临时规则");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotice.error(message);
    }
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        临时规则
        <Typography variant="caption" display="block" color="text.secondary">
          持久保存，需手动删除；仅在规则模式下生效
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {isLoading ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              加载中…
            </Typography>
          </Box>
        ) : rules.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              暂无临时规则。在连接列表中右键连接可快速添加。
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
                    aria-label="删除"
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
          清空全部
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
