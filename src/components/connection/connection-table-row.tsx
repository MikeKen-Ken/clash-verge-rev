import { Box } from "@mui/material";
import { memo, type MouseEvent, type ReactNode } from "react";

import { ProcessIcon } from "./process-icon";
import { RelativeTime } from "./connection-relative-time";
import {
  getConnectionCellValue,
  type ConnectionTableDisplayColumn,
  type ConnectionTableRowSnapshot,
} from "./connection-table-model";

interface ConnectionTableRowProps {
  row: IConnectionsItem;
  snapshot: ConnectionTableRowSnapshot;
  columns: ConnectionTableDisplayColumn[];
  top: number;
  height: number;
  onShowDetail: (data: IConnectionsItem) => void;
  onContextMenu?: (event: MouseEvent, connection: IConnectionsItem) => void;
}

const renderCellContent = (
  column: ConnectionTableDisplayColumn,
  row: IConnectionsItem,
  snapshot: ConnectionTableRowSnapshot,
): ReactNode => {
  if (column.field === "time") {
    return <RelativeTime start={row.start} />;
  }
  if (column.field === "process") {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
        <ProcessIcon processPath={row.metadata.processPath} size={16} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {snapshot.process}
        </span>
      </Box>
    );
  }
  if (column.field === "download") return snapshot.downloadText;
  if (column.field === "upload") return snapshot.uploadText;
  if (column.field === "dlSpeed") return snapshot.downloadSpeedText;
  if (column.field === "ulSpeed") return snapshot.uploadSpeedText;
  return getConnectionCellValue(column.field, snapshot);
};

export const ConnectionTableRow = memo(function ConnectionTableRow({
  row,
  snapshot,
  columns,
  top,
  height,
  onShowDetail,
  onContextMenu,
}: ConnectionTableRowProps) {
  return (
    <Box
      onClick={() => onShowDetail(row)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event, row);
      }}
      sx={{
        display: "flex",
        position: "absolute",
        left: 0,
        right: 0,
        height,
        transform: `translateY(${top}px)`,
        borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
        cursor: "pointer",
        "&:hover": {
          backgroundColor: (theme) => theme.palette.action.hover,
        },
      }}
    >
      {columns.map((column) => (
        <Box
          key={column.field}
          sx={{
            flex: `0 0 ${column.size}px`,
            minWidth: column.minWidth,
            boxSizing: "border-box",
            px: 1,
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: column.align === "right" ? "flex-end" : "flex-start",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {renderCellContent(column, row, snapshot)}
        </Box>
      ))}
    </Box>
  );
});
