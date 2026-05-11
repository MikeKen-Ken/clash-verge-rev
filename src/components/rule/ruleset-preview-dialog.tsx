import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import Button from "@mui/material/Button";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import { BaseSearchBox } from "@/components/base";
import { getRuleProviderPreview } from "@/services/cmds";
import type { RulesetPreviewFlatRow } from "@/services/rule-provider-preview";
import { showNotice } from "@/services/notice-service";

export type RulesetPreviewMode = "single" | "all";

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (; ;) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(cap, items.length) }, () => worker()),
  );
  return results;
}

type Props = {
  open: boolean;
  onClose: () => void;
  mode: RulesetPreviewMode;
  /** single 模式下要预览的规则集名称 */
  singleName: string;
  /** all 模式下按此顺序逐个拉取并拼接 */
  allNamesOrdered: string[];
};

/** 查看单个或按顺序拼接全部规则集在核心内的展开规则，带搜索过滤。 */
export function RulesetPreviewDialog(props: Props) {
  const { open, onClose, mode, singleName, allNamesOrdered } = props;
  const { t } = useTranslation();

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<RulesetPreviewFlatRow[]>([]);
  const [meta, setMeta] = useState<{
    titleHint?: string;
  }>({});

  const [match, setMatch] = useState<(line: string) => boolean>(() => () => true);

  const loadPreview = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setRows([]);
    setMeta({});
    try {
      if (mode === "single") {
        const data = await getRuleProviderPreview(singleName);
        const next = data.rules.map((r) => ({
          rulesetName: data.name,
          ruleType: r.ruleType,
          payload: r.payload,
          policy: r.policy,
        }));
        setRows(next);
        setMeta({
          titleHint: `${data.behavior} · ${t("rules.page.provider.preview.ruleSetPolicy")}: ${data.policy || "—"}`,
        });
      } else {
        const results = await mapWithConcurrency(
          allNamesOrdered,
          4,
          (name) => getRuleProviderPreview(name),
        );
        const acc = results.flatMap((data) =>
          data.rules.map((r) => ({
            rulesetName: data.name,
            ruleType: r.ruleType,
            payload: r.payload,
            policy: r.policy,
          })),
        );
        setRows(acc);
      }
    } catch (e) {
      showNotice.error(
        "rules.feedback.notifications.provider.previewLoadFailed",
        {
          message: String(e),
        },
      );
    } finally {
      setLoading(false);
    }
  }, [open, mode, singleName, allNamesOrdered, t]);

  useEffect(() => {
    if (!open) {
      setRows([]);
      setMeta({});
      setMatch(() => () => true);
      return;
    }
    void loadPreview();
  }, [open, loadPreview]);

  const title =
    mode === "single"
      ? t("rules.page.provider.preview.titleSingle", { name: singleName })
      : t("rules.page.provider.preview.titleAll");

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Typography variant="h6">{title}</Typography>
        {meta.titleHint ? (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            {meta.titleHint}
          </Typography>
        ) : null}
        {!loading ? (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            {t("rules.page.provider.preview.ruleCount", { count: rows.length })}
          </Typography>
        ) : null}
      </DialogTitle>

      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1, minHeight: 400 }}>
        <BaseSearchBox
          placeholder={t("rules.page.provider.preview.searchPlaceholder")}
          onSearch={(matcher, _state) => {
            setMatch(() => matcher);
          }}
        />
        <PreviewList rows={rows} loading={loading} match={match} />
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>{t("shared.actions.close")}</Button>
      </DialogActions>
    </Dialog>
  );
}

function PreviewList({
  rows,
  loading,
  match,
}: {
  rows: RulesetPreviewFlatRow[];
  loading: boolean;
  match: (line: string) => boolean;
}) {
  const { t } = useTranslation();

  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        match(
          `${r.rulesetName}\t${r.ruleType}\t${r.payload}\t${r.policy}`,
        ),
      ),
    [rows, match],
  );

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" py={6}>
        <CircularProgress />
      </Box>
    );
  }

  if (filtered.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 2 }}>
        {t("rules.page.provider.preview.empty")}
      </Typography>
    );
  }

  const itemContent = (_index: number, row: RulesetPreviewFlatRow) => (
    <Box
      sx={{
        display: "flex",
        gap: 1,
        py: 0.75,
        px: 0.5,
        borderBottom: "1px solid var(--divider-color)",
        alignItems: "baseline",
      }}
    >
      <Typography
        variant="body2"
        color="secondary.main"
        sx={{ flex: "0 0 140px", minWidth: 0 }}
        noWrap
        title={row.rulesetName}
      >
        {row.rulesetName}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ flex: "0 0 160px" }} noWrap>
        {row.ruleType}
      </Typography>
      <Typography variant="body2" sx={{ flex: "1 1 auto", minWidth: 0 }} noWrap title={row.payload}>
        {row.payload}
      </Typography>
      <Typography variant="body2" color="primary.main" sx={{ flex: "0 0 120px" }} noWrap>
        {row.policy || "—"}
      </Typography>
    </Box>
  );

  return (
    <>
      <Box
        sx={{
          display: "flex",
          gap: 1,
          py: 0.5,
          px: 0.5,
          borderBottom: "2px solid var(--divider-color)",
          fontWeight: 600,
        }}
      >
        <Typography variant="caption" sx={{ flex: "0 0 140px" }}>
          {t("rules.page.provider.preview.columns.ruleset")}
        </Typography>
        <Typography variant="caption" sx={{ flex: "0 0 160px" }}>
          {t("rules.page.provider.preview.columns.type")}
        </Typography>
        <Typography variant="caption" sx={{ flex: "1 1 auto" }}>
          {t("rules.page.provider.preview.columns.payload")}
        </Typography>
        <Typography variant="caption" sx={{ flex: "0 0 120px" }}>
          {t("rules.page.provider.preview.columns.policy")}
        </Typography>
      </Box>
      <Virtuoso
        style={{ height: 440, width: "100%" }}
        data={filtered}
        itemContent={itemContent}
      />
    </>
  );
}
