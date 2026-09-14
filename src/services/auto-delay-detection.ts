/** One scheduled probe at a time; stopping prevents further ticks. */
export function startAutoDelayDetection(options: {
  intervalMinutes?: number;
  run: (isCancelled: () => boolean) => Promise<void>;
  onError: (error: unknown) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): () => void {
  const configured = options.intervalMinutes ?? 5;
  const minutes =
    Number.isFinite(configured) && configured > 0 ? configured : 5;
  const intervalMs = Math.min(2_147_483_647, Math.max(1, minutes) * 60_000);
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimer(() => {
      void tick();
    }, intervalMs);
  };
  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    try {
      await options.run(() => stopped);
    } catch (error) {
      options.onError(error);
    } finally {
      if (!stopped) schedule();
    }
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
}
