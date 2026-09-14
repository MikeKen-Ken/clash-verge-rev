import type { DelayUpdate } from "./delay";

/** Prefer newer core results, but keep an in-flight UI test visible until it settles. */
export function resolveDelayUpdate(
  cached: DelayUpdate | undefined,
  history: IProxyItem["history"] | undefined,
): DelayUpdate | undefined {
  if (cached?.delay === -2) return cached;
  const last = history?.[history.length - 1];
  if (!last) return cached;
  const parsed = Date.parse(last.time);
  const updatedAt = Number.isFinite(parsed) ? parsed : 0;
  if (cached && cached.updatedAt >= updatedAt) return cached;
  // Preserve the existing core-history failure sentinel used by proxy cards.
  return { delay: last.delay || 1e6, updatedAt };
}
