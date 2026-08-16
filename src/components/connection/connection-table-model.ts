import parseTraffic from "@/utils/parse-traffic";
import { truncateStr } from "@/utils/truncate-str";

export const CONNECTION_TABLE_FIELDS = [
  "host",
  "download",
  "upload",
  "dlSpeed",
  "ulSpeed",
  "chains",
  "rule",
  "process",
  "time",
  "source",
  "remoteDestination",
  "type",
] as const;

export type ConnectionTableField = (typeof CONNECTION_TABLE_FIELDS)[number];

export interface ConnectionTableDisplayColumn {
  field: ConnectionTableField;
  size: number;
  minWidth: number;
  align?: "left" | "right";
}

export interface ConnectionTableRowSnapshot {
  row: IConnectionsItem;
  host: string;
  process: string;
  source: string;
  destination: string;
  chainsText: string;
  ruleText: string;
  typeLabel: string;
  startTime: number;
  uploadText: string;
  downloadText: string;
  uploadSpeedText: string;
  downloadSpeedText: string;
}

const sameStaticConnection = (
  left: IConnectionsItem,
  right: IConnectionsItem,
) =>
  left.metadata === right.metadata &&
  left.chains === right.chains &&
  left.rule === right.rule &&
  left.rulePayload === right.rulePayload &&
  left.ruleDetail === right.ruleDetail &&
  left.start === right.start;

const sameTrafficConnection = (
  left: IConnectionsItem,
  right: IConnectionsItem,
) =>
  left.upload === right.upload &&
  left.download === right.download &&
  left.curUpload === right.curUpload &&
  left.curDownload === right.curDownload;

const formatTrafficText = (value: number | undefined) =>
  parseTraffic(value).join(" ");

export const getConnectionHost = (row: IConnectionsItem) => {
  const { metadata } = row;
  return metadata.host
    ? `${metadata.host}:${metadata.destinationPort}`
    : `${metadata.remoteDestination}:${metadata.destinationPort}`;
};

export const getConnectionProcess = (row: IConnectionsItem) =>
  truncateStr(row.metadata.process || row.metadata.processPath) ?? "";

export const getConnectionSource = (row: IConnectionsItem) =>
  `${row.metadata.sourceIP}:${row.metadata.sourcePort}`;

export const getConnectionDestination = (row: IConnectionsItem) => {
  const { metadata } = row;
  return metadata.destinationIP
    ? `${metadata.destinationIP}:${metadata.destinationPort}`
    : `${metadata.remoteDestination}:${metadata.destinationPort}`;
};

export const formatConnectionChains = (chains: string[] | undefined) =>
  [...(chains ?? [])].reverse().join(" / ");

export const getConnectionRule = (row: IConnectionsItem) => {
  if (row.rulePayload) {
    return row.ruleDetail
      ? `${row.rulePayload} --> [${row.ruleDetail}]`
      : row.rulePayload;
  }
  return row.rule;
};

export const getConnectionTypeLabel = (row: IConnectionsItem) =>
  `${row.metadata.type}(${row.metadata.network})`;

export const getConnectionStartTime = (row: IConnectionsItem) =>
  new Date(row.start || 0).getTime();

export const createTableRowSnapshot = (
  row: IConnectionsItem,
  previous?: ConnectionTableRowSnapshot,
): ConnectionTableRowSnapshot => {
  const previousRow = previous?.row;
  const sameStatic = previousRow && sameStaticConnection(previousRow, row);
  const sameTraffic = previousRow && sameTrafficConnection(previousRow, row);
  if (sameStatic && sameTraffic && previous) return previous;

  return {
    row,
    host: sameStatic && previous ? previous.host : getConnectionHost(row),
    process:
      sameStatic && previous ? previous.process : getConnectionProcess(row),
    source: sameStatic && previous ? previous.source : getConnectionSource(row),
    destination:
      sameStatic && previous
        ? previous.destination
        : getConnectionDestination(row),
    chainsText:
      sameStatic && previous
        ? previous.chainsText
        : formatConnectionChains(row.chains),
    ruleText: sameStatic && previous ? previous.ruleText : getConnectionRule(row),
    typeLabel:
      sameStatic && previous
        ? previous.typeLabel
        : getConnectionTypeLabel(row),
    startTime:
      sameStatic && previous ? previous.startTime : getConnectionStartTime(row),
    uploadText:
      sameTraffic && previous
        ? previous.uploadText
        : formatTrafficText(row.upload),
    downloadText:
      sameTraffic && previous
        ? previous.downloadText
        : formatTrafficText(row.download),
    uploadSpeedText:
      sameTraffic && previous
        ? previous.uploadSpeedText
        : `${formatTrafficText(row.curUpload)}/s`,
    downloadSpeedText:
      sameTraffic && previous
        ? previous.downloadSpeedText
        : `${formatTrafficText(row.curDownload)}/s`,
  };
};

export const getConnectionCellValue = (
  field: ConnectionTableField,
  snapshot: ConnectionTableRowSnapshot,
) => {
  switch (field) {
    case "host":
      return snapshot.host;
    case "download":
      return snapshot.row.download ?? 0;
    case "upload":
      return snapshot.row.upload ?? 0;
    case "dlSpeed":
      return snapshot.row.curDownload ?? 0;
    case "ulSpeed":
      return snapshot.row.curUpload ?? 0;
    case "chains":
      return snapshot.chainsText;
    case "rule":
      return snapshot.ruleText;
    case "process":
      return snapshot.process;
    case "time":
      return snapshot.startTime;
    case "source":
      return snapshot.source;
    case "remoteDestination":
      return snapshot.destination;
    case "type":
      return snapshot.typeLabel;
    default:
      return "";
  }
};

export const compareConnectionField = (
  field: ConnectionTableField,
  left: ConnectionTableRowSnapshot,
  right: ConnectionTableRowSnapshot,
) => {
  const leftValue = getConnectionCellValue(field, left);
  const rightValue = getConnectionCellValue(field, right);
  if (typeof leftValue === "number" || typeof rightValue === "number") {
    return (Number(leftValue) || 0) - (Number(rightValue) || 0);
  }
  return String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
};

/** 可见行快照缓存：超出上限时删最旧条目，避免按全表规模堆积字符串 */
export const rememberTableRowSnapshot = (
  cache: Map<string, ConnectionTableRowSnapshot>,
  row: IConnectionsItem,
  maxEntries: number,
) => {
  const previous = cache.get(row.id);
  const snapshot = createTableRowSnapshot(row, previous);
  if (previous) cache.delete(row.id);
  cache.set(row.id, snapshot);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return snapshot;
};
