const createLoader = require("./load-typescript.cjs");

function loadConnectionMerge() {
  return createLoader({
    react: {},
    swr: {},
    "tauri-plugin-mihomo-api": {},
    "./use-process-icon": { registerProcessPath() {} },
    "./use-mihomo-ws-subscription": {},
    "./use-system-state": {},
    "./use-verge": {},
    "./use-connection-setting": { DEFAULT_CLOSED_CONNECTIONS_LIMIT: 5000 },
    "@/utils/closed-connections-storage": {
      setClosedConnectionsInStorage() {},
    },
  })("src/hooks/use-connection-data.ts").mergeConnectionSnapshot;
}

function connection(index, tick = 0) {
  return {
    id: String(index),
    start: "2026-09-14T00:00:00Z",
    upload: tick * 50,
    download: tick * 100,
    metadata: {
      network: "tcp",
      type: "HTTP",
      host: `host-${index}.test`,
      sourceIP: "127.0.0.1",
      sourcePort: "1234",
      destinationIP: "192.0.2.1",
      destinationPort: "443",
      process: "",
      processPath: "",
    },
    chains: ["fixture"],
    rule: "MATCH",
    rulePayload: "",
  };
}
module.exports = { loadConnectionMerge, connection };
