export const recoveryLabels: Record<string, string> = {
  "dns-reset": "DNS reset attempted",
  "route-reset": "Route recovery attempted",
  "backup-unavailable": "No working backup found",
  "backup-verified": "Backup probe succeeded",
  switch: "Recovery selected a replacement",
  "traffic-veto": "Observed traffic prevented failover",
  coalesced: "Repeated recovery request combined",
  ignored: "Recovery request ignored",
};
export interface NetworkHealth {
  observedAt?: string;
  lastTrafficAt?: string;
  switches: number;
  failedSearches: number;
  trafficVetoes: number;
  events: { at: string; action: string; durationMs: number }[];
}
const timestamp = (value: unknown): string | undefined =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT[\d:.+Z-]{8,30}$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;

/** Export only known evidence fields. Never spread controller payloads into reports. */
export function sanitizeNetworkHealth(raw: unknown): NetworkHealth {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const events = Array.isArray(data.events) ? data.events.slice(-64) : [];
  return {
    observedAt: timestamp(data.observedAt),
    lastTrafficAt: timestamp(data.lastTrafficAt),
    switches: count(data.switches),
    failedSearches: count(data.failedSearches),
    trafficVetoes: count(data.trafficVetoes),
    events: events.flatMap((event) => {
      if (!event || typeof event !== "object") return [];
      const at = timestamp(event.at);
      if (!at || !Object.hasOwn(recoveryLabels, event.action)) return [];
      return [
        {
          at,
          action: String(event.action),
          durationMs: count(event.durationMs),
        },
      ];
    }),
  };
}
