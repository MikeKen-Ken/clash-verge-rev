import {
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useMemo, useState } from "react";

import { useClash } from "@/hooks/use-clash";
import { showNotice } from "@/services/notice-service";

import { addSessionRule } from "./api";
import { buildRuleCandidates } from "./build-candidates";
import {
  buildPolicyTargets,
  formatPolicyLabel,
} from "./policy-targets";
import type { SessionRuleCandidate } from "./types";
import { refreshSessionRules } from "./use-session-rules";

interface Props {
  connection: IConnectionsItem | null;
  position: { top: number; left: number } | null;
  onClose: () => void;
}

export function ConnectionRuleMenu({ connection, position, onClose }: Props) {
  const { clash } = useClash();
  const [adding, setAdding] = useState(false);
  const open = Boolean(connection && position);

  const candidates = useMemo(
    () => (connection ? buildRuleCandidates(connection) : []),
    [connection],
  );

  const policyTargets = useMemo(
    () => buildPolicyTargets(clash?.["proxy-groups"]),
    [clash],
  );

  const onSelect = useLockFn(
    async (candidate: SessionRuleCandidate, target: string) => {
      if (adding) return;
      setAdding(true);
      try {
        await addSessionRule({
          ruleType: candidate.ruleType,
          payload: candidate.payload,
          target,
          label: candidate.label,
        });
        await refreshSessionRules();
        showNotice.success(
          `已添加临时规则：${candidate.ruleType},${candidate.payload},${target}`,
        );
        onClose();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        showNotice.error(message);
      } finally {
        setAdding(false);
      }
    },
  );

  return (
    <Menu
      open={open}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={
        position ? { top: position.top, left: position.left } : undefined
      }
    >
      <MenuItem disabled sx={{ opacity: 1 }}>
        <ListItemText
          primary="添加到临时规则"
          secondary="重启软件后自动失效"
          primaryTypographyProps={{ fontSize: 14, fontWeight: 600 }}
          secondaryTypographyProps={{ fontSize: 12 }}
        />
      </MenuItem>
      <Divider />
      {candidates.length === 0 && (
        <MenuItem disabled>
          <Typography variant="body2" color="text.secondary">
            该连接没有可用的匹配项
          </Typography>
        </MenuItem>
      )}
      {candidates.map((candidate) => (
        <PolicySubmenu
          key={`${candidate.ruleType}:${candidate.payload}`}
          candidate={candidate}
          targets={policyTargets}
          disabled={adding}
          onSelect={onSelect}
        />
      ))}
    </Menu>
  );
}

function PolicySubmenu({
  candidate,
  targets,
  disabled,
  onSelect,
}: {
  candidate: SessionRuleCandidate;
  targets: string[];
  disabled: boolean;
  onSelect: (candidate: SessionRuleCandidate, target: string) => Promise<void>;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const submenuOpen = Boolean(anchorEl);

  return (
    <>
      <MenuItem
        disabled={disabled}
        onClick={(event) => setAnchorEl(event.currentTarget)}
      >
        <ListItemText
          primary={`${candidate.category}：${candidate.label}`}
          secondary={candidate.ruleType}
          primaryTypographyProps={{ fontSize: 13 }}
          secondaryTypographyProps={{ fontSize: 11 }}
        />
      </MenuItem>
      <Menu
        open={submenuOpen}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        {targets.map((target) => (
          <MenuItem
            key={target}
            disabled={disabled}
            onClick={() => {
              setAnchorEl(null);
              void onSelect(candidate, target);
            }}
          >
            {formatPolicyLabel(target)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
