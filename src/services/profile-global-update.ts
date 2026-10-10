import { throttle } from "lodash-es";
import { mutate } from "swr";

import { getProfiles, patchProfile, updateProfile } from "@/services/cmds";
import { showNotice } from "@/services/notice-service";
import {
  filterMergeProfileItems,
  generateMergedProfile,
} from "@/services/profile-merge";

export const GLOBAL_UPDATE_INTERVAL_OPTIONS = [8, 16, 24, 48, 72, 168] as const;

const GLOBAL_UPDATE_INTERVAL_STORAGE_KEY = "profiles.global.updateIntervalHours";
const GLOBAL_UPDATE_NEXT_AT_STORAGE_KEY = "profiles.global.nextUpdateAt";
const GLOBAL_UPDATE_INTERVAL_APPLIED_STORAGE_KEY =
  "profiles.global.updateIntervalHours.applied";

type LoadingCache = Record<string, boolean>;

interface ProfileUpdateBinding {
  setLoadingCache: (updater: (cache: LoadingCache) => LoadingCache) => void;
  getLoadingCache: () => LoadingCache;
}

let binding: ProfileUpdateBinding | null = null;
let started = false;
let generation = 0;
let timeoutId: number | undefined;
let activeHours = 24;
let updateInFlight: Promise<void> | null = null;

export function bindProfileUpdateLoadingCache(next: ProfileUpdateBinding | null) {
  binding = next;
}

export function readProfileGlobalUpdateHours(): number {
  const saved = Number(
    localStorage.getItem(GLOBAL_UPDATE_INTERVAL_STORAGE_KEY) || 0,
  );
  return (GLOBAL_UPDATE_INTERVAL_OPTIONS as readonly number[]).includes(saved)
    ? saved
    : 24;
}

function clearTimer() {
  if (timeoutId !== undefined) {
    window.clearTimeout(timeoutId);
    timeoutId = undefined;
  }
}

function persistSchedule(hours: number, nextUpdateAt: number) {
  localStorage.setItem(GLOBAL_UPDATE_INTERVAL_STORAGE_KEY, String(hours));
  localStorage.setItem(GLOBAL_UPDATE_INTERVAL_APPLIED_STORAGE_KEY, String(hours));
  localStorage.setItem(GLOBAL_UPDATE_NEXT_AT_STORAGE_KEY, String(nextUpdateAt));
}

function scheduleDelay(delay: number, token: number) {
  clearTimer();
  timeoutId = window.setTimeout(() => {
    timeoutId = undefined;
    if (!started || token !== generation) return;
    const intervalMs = activeHours * 60 * 60 * 1000;
    const following = Date.now() + intervalMs;
    persistSchedule(activeHours, following);
    void updateAllRemoteAndMerge("定时任务").finally(() => {
      if (!started || token !== generation) return;
      scheduleDelay(Math.max(1000, following - Date.now()), token);
    });
  }, delay);
}

function armTimer(intervalChanged = false) {
  if (!started) return;
  const token = ++generation;
  clearTimer();

  const hours = activeHours;
  const intervalMs = hours * 60 * 60 * 1000;
  const now = Date.now();
  const applied = Number(
    localStorage.getItem(GLOBAL_UPDATE_INTERVAL_APPLIED_STORAGE_KEY) || 0,
  );
  const resetDeadline = intervalChanged || applied !== hours;
  let nextUpdateAt = Number(
    localStorage.getItem(GLOBAL_UPDATE_NEXT_AT_STORAGE_KEY) || 0,
  );
  if (!Number.isFinite(nextUpdateAt) || nextUpdateAt <= 0 || resetDeadline) {
    nextUpdateAt = now + intervalMs;
  }

  if (!resetDeadline && nextUpdateAt <= now) {
    const following = now + intervalMs;
    persistSchedule(hours, following);
    void updateAllRemoteAndMerge("定时任务(启动补偿)").finally(() => {
      if (!started || token !== generation) return;
      scheduleDelay(Math.max(1000, following - Date.now()), token);
    });
    return;
  }

  persistSchedule(hours, nextUpdateAt);
  scheduleDelay(Math.max(1000, nextUpdateAt - now), token);
}

export function applyProfileGlobalUpdateHours(hours: number) {
  const nextHours = (GLOBAL_UPDATE_INTERVAL_OPTIONS as readonly number[]).includes(
    hours,
  )
    ? hours
    : 24;
  activeHours = nextHours;
  localStorage.setItem(GLOBAL_UPDATE_INTERVAL_STORAGE_KEY, String(nextHours));
  if (started) {
    armTimer(true);
  }
}

async function disableBuiltinProfileAutoUpdate() {
  try {
    const profiles = await getProfiles();
    const remoteItems = (profiles?.items || []).filter(
      (item) => item?.type === "remote",
    );
    await Promise.allSettled(
      remoteItems.map((item) =>
        patchProfile(item.uid, {
          option: {
            ...(item.option || {}),
            allow_auto_update: false,
            update_interval: undefined,
          },
        }),
      ),
    );
  } catch (error) {
    console.error(
      "[ProfileUpdate] Failed to disable per-profile auto update:",
      error,
    );
  }
}

/** Keep the remote-profile interval running for the whole app session. */
export function startProfileGlobalUpdate(): () => void {
  if (started) {
    return () => {};
  }
  started = true;
  activeHours = readProfileGlobalUpdateHours();
  void disableBuiltinProfileAutoUpdate();
  armTimer(false);
  return () => {
    started = false;
    generation += 1;
    clearTimer();
  };
}

export function updateAllRemoteAndMerge(source: string): Promise<void> {
  if (updateInFlight) return updateInFlight;
  updateInFlight = runUpdateAllRemoteAndMerge(source).finally(() => {
    updateInFlight = null;
  });
  return updateInFlight;
}

async function runUpdateAllRemoteAndMerge(source: string) {
  showNotice.info(`${source}: starting remote rule update`, 1500);
  let failedUpdates = 0;
  const throttleMutate = throttle(
    () => {
      void mutate("getProfiles");
    },
    2000,
    { trailing: true },
  );
  const freshProfiles = await getProfiles();
  const cache = binding?.getLoadingCache() ?? {};
  const items = filterMergeProfileItems(freshProfiles?.items).filter(
    (item) => item.type === "remote" && !cache[item.uid],
  );

  binding?.setLoadingCache((current) => ({
    ...current,
    ...Object.fromEntries(items.map((item) => [item.uid, true])),
  }));

  await Promise.allSettled(
    items.map(async (item) => {
      try {
        await updateProfile(item.uid);
        throttleMutate();
      } catch (err: any) {
        failedUpdates += 1;
        console.error(`Failed to update subscription ${item.uid}:`, err);
      } finally {
        binding?.setLoadingCache((current) => ({
          ...current,
          [item.uid]: false,
        }));
      }
    }),
  );

  if (failedUpdates > 0) {
    showNotice.error(
      `${failedUpdates} subscription updates or activations failed. Merge was not started.`,
    );
    await mutate("getProfiles");
    return;
  }
  showNotice.success(
    `${source}: remote rule update complete; starting merge`,
    2000,
  );
  await generateMergedProfile();
}
