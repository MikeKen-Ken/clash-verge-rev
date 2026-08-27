import { ViewColumnRounded } from "@mui/icons-material";
import { Box, IconButton, Tooltip } from "@mui/material";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocalStorage } from "foxact/use-local-storage";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";

import {
  CONNECTION_TABLE_ORDER_KEY,
  CONNECTION_TABLE_VISIBILITY_KEY,
  syncConnectionTableUiToBackupFile,
} from "@/services/ui-preferences-backup";

import {
  ConnectionColumnManager,
  type ConnectionColumnOption,
} from "./connection-column-manager";
import { ConnectionTableRow } from "./connection-table-row";
import {
  compareConnectionField,
  rememberTableRowSnapshot,
  type ConnectionTableDisplayColumn,
  type ConnectionTableField,
  type ConnectionTableRowSnapshot,
} from "./connection-table-model";

const ROW_HEIGHT = 40;
const OVERSCAN_ROWS = 6;
const MAX_ROW_SNAPSHOT_CACHE_SIZE = 2_000;

const reconcileColumnOrder = (
  storedOrder: string[],
  baseFields: string[],
): string[] => {
  const filtered = storedOrder.filter((field) => baseFields.includes(field));
  const missing = baseFields.filter((field) => !filtered.includes(field));
  return [...filtered, ...missing];
};

interface BaseColumn {
  field: ConnectionTableField;
  headerName: string;
  width: number;
  minWidth: number;
  align?: "left" | "right";
}

interface SortingState {
  id: ConnectionTableField;
  desc: boolean;
}

type ColumnSizingState = Record<string, number>;
type VisibilityState = Record<string, boolean>;

const resolveColumnSize = (
  column: BaseColumn,
  storedSize: number | undefined,
) => {
  if (typeof storedSize !== "number" || !Number.isFinite(storedSize)) {
    return column.width;
  }
  return Math.max(column.minWidth, storedSize);
};

interface Props {
  connections: IConnectionsItem[];
  onShowDetail: (data: IConnectionsItem) => void;
  onContextMenu?: (event: MouseEvent, connection: IConnectionsItem) => void;
  columnManagerOpen: boolean;
  onOpenColumnManager: () => void;
  onCloseColumnManager: () => void;
}

export const ConnectionTable = (props: Props) => {
  const {
    connections,
    onShowDetail,
    onContextMenu,
    columnManagerOpen,
    onOpenColumnManager,
    onCloseColumnManager,
  } = props;
  const { t } = useTranslation();
  const [columnWidths, setColumnWidths] = useLocalStorage<ColumnSizingState>(
    "connection-table-widths",
    {},
  );
  const [columnVisibilityModel, setColumnVisibilityModel] =
    useLocalStorage<VisibilityState>(
      CONNECTION_TABLE_VISIBILITY_KEY,
      {},
      {
        serializer: JSON.stringify,
        deserializer: (value) => {
          try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === "object") return parsed;
          } catch (err) {
            console.warn("Failed to parse connection-table-visibility", err);
          }
          return {};
        },
      },
    );
  const [columnOrder, setColumnOrder] = useLocalStorage<string[]>(
    CONNECTION_TABLE_ORDER_KEY,
    [],
    {
      serializer: JSON.stringify,
      deserializer: (value) => {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch (err) {
          console.warn("Failed to parse connection-table-order", err);
        }
        return [];
      },
    },
  );
  const [sorting, setSorting] = useState<SortingState | null>(null);
  const snapshotCacheRef = useRef(
    new Map<string, ConnectionTableRowSnapshot>(),
  );
  const resizeStateRef = useRef<{
    field: ConnectionTableField;
    startX: number;
    startSize: number;
  } | null>(null);

  const baseColumns = useMemo<BaseColumn[]>(
    () => [
      {
        field: "host",
        headerName: t("connections.components.fields.host"),
        width: 180,
        minWidth: 140,
      },
      {
        field: "download",
        headerName: t("shared.labels.downloaded"),
        width: 76,
        minWidth: 60,
        align: "right",
      },
      {
        field: "upload",
        headerName: t("shared.labels.uploaded"),
        width: 76,
        minWidth: 60,
        align: "right",
      },
      {
        field: "dlSpeed",
        headerName: t("connections.components.fields.dlSpeed"),
        width: 76,
        minWidth: 60,
        align: "right",
      },
      {
        field: "ulSpeed",
        headerName: t("connections.components.fields.ulSpeed"),
        width: 76,
        minWidth: 60,
        align: "right",
      },
      {
        field: "chains",
        headerName: t("connections.components.fields.chains"),
        width: 280,
        minWidth: 160,
      },
      {
        field: "rule",
        headerName: t("connections.components.fields.rule"),
        width: 220,
        minWidth: 160,
      },
      {
        field: "process",
        headerName: t("connections.components.fields.process"),
        width: 180,
        minWidth: 140,
      },
      {
        field: "time",
        headerName: t("connections.components.fields.time"),
        width: 100,
        minWidth: 80,
        align: "right",
      },
      {
        field: "source",
        headerName: t("connections.components.fields.source"),
        width: 160,
        minWidth: 120,
      },
      {
        field: "remoteDestination",
        headerName: t("connections.components.fields.destination"),
        width: 160,
        minWidth: 120,
      },
      {
        field: "type",
        headerName: t("connections.components.fields.type"),
        width: 120,
        minWidth: 80,
      },
    ],
    [t],
  );

  const baseFields = useMemo(
    () => baseColumns.map((column) => column.field),
    [baseColumns],
  );

  useEffect(() => {
    setColumnOrder((prevValue) => {
      const prev = Array.isArray(prevValue) ? prevValue : [];
      const reconciled = reconcileColumnOrder(prev, baseFields);
      if (
        reconciled.length === prev.length &&
        reconciled.every((field, i) => field === prev[i])
      ) {
        return prevValue;
      }
      return reconciled;
    });
  }, [baseFields, setColumnOrder]);

  const skipInitialUiSync = useRef(true);
  useEffect(() => {
    if (skipInitialUiSync.current) {
      skipInitialUiSync.current = false;
      return;
    }
    void syncConnectionTableUiToBackupFile({
      order: Array.isArray(columnOrder) ? columnOrder : [],
      visibility: columnVisibilityModel ?? {},
    });
  }, [columnOrder, columnVisibilityModel]);

  const orderedColumns = useMemo(() => {
    const byField = new Map(baseColumns.map((column) => [column.field, column]));
    const order = reconcileColumnOrder(
      Array.isArray(columnOrder) ? columnOrder : [],
      baseFields,
    );
    return order
      .map((field) => byField.get(field as ConnectionTableField))
      .filter((column): column is BaseColumn => Boolean(column));
  }, [baseColumns, baseFields, columnOrder]);

  const displayColumns = useMemo<ConnectionTableDisplayColumn[]>(() => {
    const visibility = columnVisibilityModel ?? {};
    return orderedColumns
      .filter((column) => visibility[column.field] !== false)
      .map((column) => ({
        field: column.field,
        size: resolveColumnSize(column, columnWidths?.[column.field]),
        minWidth: column.minWidth,
        align: column.align,
      }));
  }, [columnVisibilityModel, columnWidths, orderedColumns]);

  const tableWidth = useMemo(
    () => displayColumns.reduce((sum, column) => sum + column.size, 0),
    [displayColumns],
  );

  const getSnapshot = useCallback((row: IConnectionsItem) => {
    return rememberTableRowSnapshot(
      snapshotCacheRef.current,
      row,
      MAX_ROW_SNAPSHOT_CACHE_SIZE,
    );
  }, []);

  const sortedConnections = useMemo(() => {
    if (!sorting) return connections;
    const next = connections.slice();
    next.sort((left, right) => {
      const result = compareConnectionField(
        sorting.id,
        getSnapshot(left),
        getSnapshot(right),
      );
      return sorting.desc ? -result : result;
    });
    return next;
  }, [connections, getSnapshot, sorting]);

  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: sortedConnections.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const handleToggleSort = useCallback((field: ConnectionTableField) => {
    setSorting((prev) => {
      if (!prev || prev.id !== field) return { id: field, desc: true };
      if (prev.desc) return { id: field, desc: false };
      return null;
    });
  }, []);

  const handleToggleVisibility = useCallback(
    (field: string, visible: boolean) => {
      setColumnVisibilityModel((prev) => {
        const current = prev ?? {};
        const visibleCount = orderedColumns.reduce((count, column) => {
          const isVisible =
            column.field === field
              ? visible
              : (current[column.field] ?? true) !== false;
          return count + (isVisible ? 1 : 0);
        }, 0);
        if (visibleCount === 0) return current;
        const next = { ...current };
        if (visible) delete next[field];
        else next[field] = false;
        return next;
      });
    },
    [orderedColumns, setColumnVisibilityModel],
  );

  const handleOrderChange = useCallback(
    (order: string[]) => {
      setColumnOrder(reconcileColumnOrder(order, baseFields));
    },
    [baseFields, setColumnOrder],
  );

  const handleResetColumns = useCallback(() => {
    setColumnVisibilityModel({});
    setColumnOrder([]);
  }, [setColumnOrder, setColumnVisibilityModel]);

  const managerColumns = useMemo<ConnectionColumnOption[]>(
    () =>
      orderedColumns.map((column) => ({
        id: column.field,
        label: column.headerName,
        visible: (columnVisibilityModel ?? {})[column.field] !== false,
        toggleVisibility: (visible) =>
          handleToggleVisibility(column.field, visible),
      })),
    [columnVisibilityModel, handleToggleVisibility, orderedColumns],
  );

  const applyColumnResize = useCallback(
    (clientX: number) => {
      const resize = resizeStateRef.current;
      if (!resize) return;
      const column = orderedColumns.find((item) => item.field === resize.field);
      if (!column) return;
      const nextSize = resolveColumnSize(
        column,
        resize.startSize + (clientX - resize.startX),
      );
      setColumnWidths((prev) => ({
        ...(prev ?? {}),
        [resize.field]: nextSize,
      }));
    },
    [orderedColumns, setColumnWidths],
  );

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      applyColumnResize(event.clientX);
    };
    const handleMouseUp = () => {
      resizeStateRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [applyColumnResize]);

  return (
    <>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          position: "relative",
          fontFamily: (theme) => theme.typography.fontFamily,
        }}
      >
        <Tooltip title={t("connections.components.columnManager.title")}>
          <IconButton
            size="small"
            onClick={onOpenColumnManager}
            sx={{
              position: "absolute",
              top: 4,
              right: 4,
              zIndex: 3,
              backgroundColor: "transparent",
              "&:hover": {
                backgroundColor: (theme) => theme.palette.action.hover,
              },
            }}
          >
            <ViewColumnRounded fontSize="small" />
          </IconButton>
        </Tooltip>
        <Box
          ref={tableContainerRef}
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
            borderRadius: 1,
            border: "none",
            "&::-webkit-scrollbar": {
              height: 8,
            },
          }}
        >
          <Box sx={{ minWidth: "100%", width: tableWidth }}>
            <Box sx={{ position: "sticky", top: 0, zIndex: 2 }}>
              <Box
                sx={{
                  display: "flex",
                  borderBottom: (theme) =>
                    `1px solid ${theme.palette.divider}`,
                  backgroundColor: "transparent",
                }}
              >
                {displayColumns.map((column) => {
                  const header = orderedColumns.find(
                    (item) => item.field === column.field,
                  );
                  const sorted =
                    sorting?.id === column.field
                      ? sorting.desc
                        ? "desc"
                        : "asc"
                      : null;
                  return (
                    <Box
                      key={column.field}
                      sx={{
                        flex: `0 0 ${column.size}px`,
                        minWidth: column.minWidth,
                        display: "flex",
                        alignItems: "center",
                        position: "relative",
                        boxSizing: "border-box",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "text.secondary",
                        userSelect: "none",
                        "&:hover": {
                          backgroundColor: (theme) =>
                            theme.palette.action.hover,
                        },
                      }}
                    >
                      <Box
                        component="span"
                        onClick={() => handleToggleSort(column.field)}
                        sx={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent:
                            column.align === "right" ? "flex-end" : "flex-start",
                          gap: 0.5,
                          px: 1,
                          py: 1,
                          cursor: "pointer",
                        }}
                      >
                        {header?.headerName}
                        {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : null}
                      </Box>
                      <Box
                        onClick={(event) => event.stopPropagation()}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          resizeStateRef.current = {
                            field: column.field,
                            startX: event.clientX,
                            startSize: column.size,
                          };
                        }}
                        sx={{
                          cursor: "col-resize",
                          position: "absolute",
                          right: 0,
                          top: 0,
                          width: 4,
                          height: "100%",
                          transform: "translateX(50%)",
                          "&:hover": {
                            backgroundColor: (theme) =>
                              theme.palette.action.active,
                          },
                        }}
                      />
                    </Box>
                  );
                })}
              </Box>
            </Box>
            <Box sx={{ position: "relative", height: totalSize }}>
              {virtualRows.map((virtualRow) => {
                const row = sortedConnections[virtualRow.index];
                if (!row) return null;
                return (
                  <ConnectionTableRow
                    key={row.id}
                    row={row}
                    snapshot={getSnapshot(row)}
                    columns={displayColumns}
                    top={virtualRow.start}
                    height={virtualRow.size}
                    onShowDetail={onShowDetail}
                    onContextMenu={onContextMenu}
                  />
                );
              })}
            </Box>
          </Box>
        </Box>
      </Box>
      <ConnectionColumnManager
        open={columnManagerOpen}
        columns={managerColumns}
        onClose={onCloseColumnManager}
        onOrderChange={handleOrderChange}
        onReset={handleResetColumns}
      />
    </>
  );
};
