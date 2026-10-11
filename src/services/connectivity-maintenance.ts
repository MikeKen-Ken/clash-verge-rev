/** Same bounds as the Android background probe. */
export const CONNECTIVITY_PROBE_INTERVAL_MS = 60_000;
export const CONNECTIVITY_PROBE_COOLDOWN_MS = 5 * 60_000;
export const CONNECTIVITY_PROBE_BUDGET = 2;

export type ConnectivityProbeCandidate = {
  key: string;
  name: string;
  group: string;
  timeout: number;
  lastTest: number;
};

/**
 * Oldest first, at most two nodes. A missing test counts as oldest.
 * `attempts` keeps a canceled probe from occupying the slot forever.
 */
export function chooseConnectivityProbes(
  candidates: ConnectivityProbeCandidate[],
  attempts: ReadonlyMap<string, number>,
  now: number,
): ConnectivityProbeCandidate[] {
  const present = new Set<string>();
  const eligible: ConnectivityProbeCandidate[] = [];
  for (const candidate of candidates) {
    present.add(candidate.key);
    let lastTest = candidate.lastTest;
    if (lastTest > now) lastTest = 0;
    const attempted = attempts.get(candidate.key) ?? 0;
    if (attempted > lastTest) lastTest = attempted;
    if (lastTest === 0 || now - lastTest >= CONNECTIVITY_PROBE_COOLDOWN_MS) {
      eligible.push({ ...candidate, lastTest });
    }
  }
  eligible.sort((a, b) => {
    if (a.lastTest !== b.lastTest) return a.lastTest - b.lastTest;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return eligible.slice(0, CONNECTIVITY_PROBE_BUDGET);
}
