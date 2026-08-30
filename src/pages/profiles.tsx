import {
  closestCenter,
  DndContext,
  DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import {
  ClearRounded,
  ContentPasteRounded,
  DataObjectRounded,
  FolderOpenRounded,
  RefreshRounded,
  TextSnippetOutlined,
} from "@mui/icons-material";
import { LoadingButton } from "@mui/lab";
import {
  Box,
  Button,
  Divider,
  FormControl,
  Grid,
  IconButton,
  MenuItem,
  TextField,
  Select,
  Stack,
  Tooltip,
} from "@mui/material";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useLockFn } from "ahooks";
import YAML from "js-yaml";
import { throttle } from "lodash-es";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import useSWR, { mutate } from "swr";
import { closeAllConnections } from "tauri-plugin-mihomo-api";

import { BasePage, BaseStyledTextField, DialogRef } from "@/components/base";
import { ProfileItem } from "@/components/profile/profile-item";
import { ProfileMore } from "@/components/profile/profile-more";
import {
  ProfileViewer,
  ProfileViewerRef,
} from "@/components/profile/profile-viewer";
import { RuntimeYamlTransferActions } from "@/components/profile/runtime-yaml-transfer-actions";
import { ConfigViewer } from "@/components/setting/mods/config-viewer";
import { useListen } from "@/hooks/use-listen";
import { useProfiles } from "@/hooks/use-profiles";
import {
  createProfile,
  deleteProfile,
  enhanceProfiles,
  getProfiles,
  //restartCore,
  getRuntimeLogs,
  importProfile,
  openAppDir,
  patchProfile,
  readProfileFile,
  reorderProfile,
  saveProfileFile,
  updateProfile,
} from "@/services/cmds";
import { showNotice } from "@/services/notice-service";
import {
  resolveFlag,
  sortProxiesByConnectivity,
} from "@/services/proxy-region-sort";
import { useSetLoadingCache, useThemeMode } from "@/services/states";
import { debugLog } from "@/utils/debug";

// 记录profile切换状态
const debugProfileSwitch = (action: string, profile: string, extra?: any) => {
  const timestamp = new Date().toISOString().substring(11, 23);
  debugLog(`[Profile-Debug][${timestamp}] ${action}: ${profile}`, extra || "");
};

// 检查请求是否已过期
const isRequestOutdated = (
  currentSequence: number,
  requestSequenceRef: any,
  profile: string,
) => {
  if (currentSequence !== requestSequenceRef.current) {
    debugProfileSwitch(
      "REQUEST_OUTDATED",
      profile,
      `当前序列号: ${currentSequence}, 最新序列号: ${requestSequenceRef.current}`,
    );
    return true;
  }
  return false;
};

// 检查是否被中断
const isOperationAborted = (
  abortController: AbortController,
  profile: string,
) => {
  if (abortController.signal.aborted) {
    debugProfileSwitch("OPERATION_ABORTED", profile);
    return true;
  }
  return false;
};

const TRAFFIC_NODE_REGEX = /剩余流量|套餐到期|traffic|expire/i;

const buildGeneratedName = (
  flag: string,
  sourceName: string,
  index: number,
) => {
  const cleanedSourceName = sourceName.trim();
  const suffix = String(index).padStart(2, "0");
  return cleanedSourceName
    ? `${flag} ${cleanedSourceName} ${suffix}`
    : `${flag} ${suffix}`;
};

const ensureUniqueName = (baseName: string, usedNames: Set<string>) => {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  let duplicateIndex = 2;
  let nextName = `${baseName} #${duplicateIndex}`;
  while (usedNames.has(nextName)) {
    duplicateIndex += 1;
    nextName = `${baseName} #${duplicateIndex}`;
  }
  usedNames.add(nextName);
  return nextName;
};

const isValidProxyNode = (proxy: any) => {
  if (!proxy || typeof proxy !== "object") return false;
  if (typeof proxy.name !== "string" || !proxy.name.trim()) return false;
  if (TRAFFIC_NODE_REGEX.test(proxy.name)) return false;
  if (proxy.server === "127.0.0.1") return false;
  return true;
};

const GLOBAL_UPDATE_INTERVAL_OPTIONS = [8, 16, 24, 48, 72, 168] as const;
const GLOBAL_UPDATE_INTERVAL_STORAGE_KEY = "profiles.global.updateIntervalHours";
const GLOBAL_UPDATE_NEXT_AT_STORAGE_KEY = "profiles.global.nextUpdateAt";
const GLOBAL_UPDATE_INTERVAL_APPLIED_STORAGE_KEY =
  "profiles.global.updateIntervalHours.applied";
const MERGE_INCLUSION_STORAGE_KEY = "profiles.mergeInclusion";
const LOCAL_BACKUP_DESC = "auto backup before merge";
const LOCAL_BACKUP_NAME_PATTERN = /^Local-backup-\d+$/i;
const LOCAL_BACKUP_KEEP = 2;

const isLocalMergeBackup = (item: IProfileItem) =>
  item.type === "local" &&
  (LOCAL_BACKUP_NAME_PATTERN.test(item.name || "") ||
    item.desc === LOCAL_BACKUP_DESC);

const filterMergeProfileItems = (items: IProfileItem[] | undefined) =>
  (items || []).filter(
    (item): item is IProfileItem =>
      !!item && (item.type === "local" || item.type === "remote"),
  );

const loadMergeInclusionMap = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(MERGE_INCLUSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
};

const ProfilePage = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { addListener } = useListen();
  const [url, setUrl] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [activatings, setActivatings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [globalUpdateHours, setGlobalUpdateHours] = useState<number>(() => {
    const saved = Number(localStorage.getItem(GLOBAL_UPDATE_INTERVAL_STORAGE_KEY) || 0);
    return GLOBAL_UPDATE_INTERVAL_OPTIONS.includes(saved as any) ? saved : 24;
  });
  const [mergeInclusion, setMergeInclusion] = useState<Record<string, boolean>>(
    loadMergeInclusionMap,
  );

  // 防止重复切换
  const switchingProfileRef = useRef<string | null>(null);

  // 支持中断当前切换操作
  const abortControllerRef = useRef<AbortController | null>(null);

  // 只处理最新的切换请求
  const requestSequenceRef = useRef<number>(0);

  // 待处理请求跟踪，取消排队的请求
  const pendingRequestRef = useRef<Promise<any> | null>(null);

  // 处理profile切换中断
  const handleProfileInterrupt = useCallback(
    (previousSwitching: string, newProfile: string) => {
      debugProfileSwitch(
        "INTERRUPT_PREVIOUS",
        previousSwitching,
        `被 ${newProfile} 中断`,
      );

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        debugProfileSwitch("ABORT_CONTROLLER_TRIGGERED", previousSwitching);
      }

      if (pendingRequestRef.current) {
        debugProfileSwitch("CANCEL_PENDING_REQUEST", previousSwitching);
      }

      setActivatings((prev) => prev.filter((id) => id !== previousSwitching));
      showNotice.info(
        "profiles.page.feedback.notifications.switchInterrupted",
        `${previousSwitching} → ${newProfile}`,
        3000,
      );
    },
    [],
  );

  // 清理切换状态
  const cleanupSwitchState = useCallback(
    (profile: string, sequence: number) => {
      setActivatings((prev) => prev.filter((id) => id !== profile));
      switchingProfileRef.current = null;
      abortControllerRef.current = null;
      pendingRequestRef.current = null;
      debugProfileSwitch("SWITCH_END", profile, `Sequence: ${sequence}`);
    },
    [],
  );
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const { current } = location.state || {};

  const {
    profiles = {},
    activateSelected,
    patchProfiles,
    mutateProfiles,
    error,
    isStale,
  } = useProfiles();

  useEffect(() => {
    const handleFileDrop = async () => {
      const unlisten = await addListener(
        TauriEvent.DRAG_DROP,
        async (event: any) => {
          const paths = event.payload.paths;

          for (const file of paths) {
            if (!file.endsWith(".yaml") && !file.endsWith(".yml")) {
              showNotice.error("profiles.page.feedback.errors.onlyYaml");
              continue;
            }
            const item = {
              type: "local",
              name: file.split(/\/|\\/).pop() ?? "New Profile",
              desc: "",
              url: "",
              option: {
                with_proxy: false,
                self_proxy: false,
              },
            } as IProfileItem;
            const data = await readTextFile(file);
            await createProfile(item, data);
            await mutateProfiles();
          }
        },
      );

      return unlisten;
    };

    const unsubscribe = handleFileDrop();

    return () => {
      unsubscribe.then((cleanup) => cleanup());
    };
  }, [addListener, mutateProfiles, t]);

  const disablePerProfileAutoUpdate = useLockFn(async () => {
    const remoteItems = (profiles.items || []).filter((item) => item?.type === "remote");
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
  });

  const rotateLocalBackups = async (targetRaw: string) => {
    // 必须从后端拉取最新列表，避免 SWR/React 闭包中的 profileItems 过期导致重复创建备份
    const freshProfiles = await getProfiles();
    const localItems = filterMergeProfileItems(freshProfiles?.items).filter(
      (item) => item.type === "local",
    );
    const backups = localItems.filter(isLocalMergeBackup);
    backups.sort((a, b) => (b.updated || 0) - (a.updated || 0));

    // 删除多余备份，仅保留最近两个（第三个将由本次新建）
    const keep = backups.slice(0, LOCAL_BACKUP_KEEP);
    const remove = backups.slice(LOCAL_BACKUP_KEEP);
    for (const item of remove) {
      await deleteProfile(item.uid);
    }

    const older = keep[1];
    const newer = keep[0];

    if (older) {
      await patchProfile(older.uid, { name: "Local-backup-0" });
    }
    if (newer) {
      await patchProfile(newer.uid, { name: "Local-backup-1" });
    }

    await createProfile(
      {
        type: "local",
        name: "Local-backup-2",
        desc: LOCAL_BACKUP_DESC,
        url: "",
        option: {
          with_proxy: false,
          self_proxy: false,
        },
      },
      targetRaw,
    );
  };

  const sortProxiesForMerge = useCallback((proxies: any[]) => {
    return sortProxiesByConnectivity(proxies, (proxy) => String(proxy?.name || ""));
  }, []);

  const onGenerateMergedProfile = useLockFn(
    async (inclusionOverride?: Record<string, boolean>) => {
      showNotice.info("Starting profile merge", 1500);
      const freshProfiles = await getProfiles();
      const items = filterMergeProfileItems(freshProfiles?.items);
      const inclusion = inclusionOverride ?? mergeInclusion;
      const targetIndex = items.findIndex(
        (item) => item.type === "local" && !isLocalMergeBackup(item),
      );
      if (targetIndex === -1) {
        showNotice.error("No local target profile found");
        return;
      }

      const targetProfile = items[targetIndex];
      const sourceProfiles = items
        .slice(targetIndex + 1)
        .filter(
          (item) => item.type === "remote" && inclusion[item.uid] !== false,
        );

      if (!sourceProfiles.length) {
        showNotice.error("No remote subscriptions selected for merging");
        return;
      }

      try {
        const targetRaw = await readProfileFile(targetProfile.uid);
        const targetYaml = YAML.load(targetRaw) as Record<string, any>;
        if (!targetYaml || typeof targetYaml !== "object") {
          throw new Error("Target profile content is invalid");
        }

        const generatedGroupNames: string[] = [];
        const generatedProxies: any[] = [];
        const usedNames = new Set<string>();

        for (const source of sourceProfiles) {
          const sourceRaw = await readProfileFile(source.uid);
          const sourceYaml = YAML.load(sourceRaw) as Record<string, any>;
          const sourceProxiesRaw = Array.isArray(sourceYaml?.proxies)
            ? sourceYaml.proxies.filter(isValidProxyNode)
            : [];
          const sourceProxies = sortProxiesForMerge(sourceProxiesRaw);

          const sourceDisplayName = source.name || source.desc || source.uid;
          const localFlagCounters = new Map<string, number>();
          let droppedCount = 0;

          for (const proxy of sourceProxies) {
            const proxyName = String(proxy?.name || "");
            const flag = resolveFlag(proxyName);
            // 中文关键字未命中：归属无法确定，直接丢弃，不进入合并结果
            if (!flag) {
              droppedCount += 1;
              continue;
            }
            const nextIndex = (localFlagCounters.get(flag) || 0) + 1;
            localFlagCounters.set(flag, nextIndex);
            const baseName = buildGeneratedName(flag, sourceDisplayName, nextIndex);
            const generatedName = ensureUniqueName(baseName, usedNames);

            generatedGroupNames.push(generatedName);
            generatedProxies.push({
              ...proxy,
              name: generatedName,
            });
          }

          if (droppedCount > 0) {
            debugLog(
              `[ProfileMerge] ${sourceDisplayName}: skipped ${droppedCount} nodes without a matching country keyword`,
            );
          }
        }

        if (!generatedProxies.length) {
          throw new Error("No valid proxies generated from source subscriptions");
        }

        const profileGroups = Array.isArray(targetYaml["proxy-groups"])
          ? targetYaml["proxy-groups"]
          : [];
        const firstNodeGroup = profileGroups.find(
          (group: any) => group?.name === "🚀 节点选择",
        );
        if (firstNodeGroup && typeof firstNodeGroup === "object") {
          firstNodeGroup.proxies = generatedGroupNames;
        }

        targetYaml.proxies = generatedProxies;

        await rotateLocalBackups(targetRaw);

        const nextText = YAML.dump(targetYaml, {
          lineWidth: -1,
          noRefs: true,
        });
        await saveProfileFile(targetProfile.uid, nextText);
        await enhanceProfiles();
        await mutateProfiles();
        showNotice.success(`Merge complete: processed ${sourceProfiles.length} remote profiles`, 3000);
      } catch (err: any) {
        showNotice.error(`Failed to generate merged profile: ${String(err?.message || err)}`);
      }
    },
  );

  const updateAllRemoteAndMerge = useLockFn(async (source: string) => {
    showNotice.info(`${source}: starting remote rule update`, 1500);
    const throttleMutate = throttle(mutateProfiles, 2000, {
      trailing: true,
    });
    const updateOne = async (uid: string) => {
      try {
        await updateProfile(uid);
        throttleMutate();
      } catch (err: any) {
        console.error(`Failed to update subscription ${uid}:`, err);
      } finally {
        setLoadingCache((cache) => ({ ...cache, [uid]: false }));
      }
    };

    await new Promise<void>((resolve) => {
      setLoadingCache((cache) => {
        const items = profileItems.filter(
          (e) => e.type === "remote" && !cache[e.uid],
        );
        const change = Object.fromEntries(items.map((e) => [e.uid, true]));
        Promise.allSettled(items.map((e) => updateOne(e.uid))).then(() => resolve());
        return { ...cache, ...change };
      });
    });

    showNotice.success(`${source}: remote rule update complete; starting merge`, 2000);
    await onGenerateMergedProfile();
  });

  // 添加紧急恢复功能
  const onEmergencyRefresh = useLockFn(async () => {
    debugLog("[EmergencyRefresh] Starting forced refresh of all data");

    try {
      // 清除所有SWR缓存
      await mutate(() => true, undefined, { revalidate: false });

      // 强制重新获取配置数据
      await mutateProfiles(undefined, {
        revalidate: true,
        rollbackOnError: false,
      });

      // 等待状态稳定后增强配置
      await new Promise((resolve) => setTimeout(resolve, 500));
      await onEnhance(false);
      await onGenerateMergedProfile();

      showNotice.success(
        "profiles.page.feedback.notices.forceRefreshCompleted",
        2000,
      );
    } catch (error) {
      console.error("[EmergencyRefresh] Failed:", error);
      showNotice.error(
        "profiles.page.feedback.notices.emergencyRefreshFailed",
        { message: String(error) },
        4000,
      );
    }
  });

  const { data: chainLogs = {}, mutate: mutateLogs } = useSWR(
    "getRuntimeLogs",
    getRuntimeLogs,
  );

  const viewerRef = useRef<ProfileViewerRef>(null);
  const configRef = useRef<DialogRef>(null);

  // distinguish type
  const profileItems = useMemo(
    () => filterMergeProfileItems(profiles.items),
    [profiles],
  );

  const mergeTargetIndex = useMemo(
    () =>
      profileItems.findIndex(
        (item) => item.type === "local" && !isLocalMergeBackup(item),
      ),
    [profileItems],
  );

  const firstLocalUid =
    mergeTargetIndex >= 0 ? profileItems[mergeTargetIndex]?.uid : undefined;

  const onMergeInclusionChange = useLockFn(async (uid: string, included: boolean) => {
    const next = { ...mergeInclusion, [uid]: included };
    setMergeInclusion(next);
    localStorage.setItem(MERGE_INCLUSION_STORAGE_KEY, JSON.stringify(next));
    await onGenerateMergedProfile(next);
  });

  useEffect(() => {
    if (mergeTargetIndex < 0) return;
    setMergeInclusion((prev) => {
      let changed = false;
      const next = { ...prev };
      profileItems.slice(mergeTargetIndex + 1).forEach((item) => {
        if (item.type !== "remote" || next[item.uid] !== undefined) return;
        next[item.uid] = true;
        changed = true;
      });
      if (!changed) return prev;
      localStorage.setItem(MERGE_INCLUSION_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [profileItems, mergeTargetIndex]);

  const currentActivatings = () => {
    return [...new Set([profiles.current ?? ""])].filter(Boolean);
  };

  const onImport = async () => {
    if (!url) return;
    // 校验url是否为http/https
    if (!/^https?:\/\//i.test(url)) {
      showNotice.error("profiles.page.feedback.errors.invalidUrl");
      return;
    }
    setLoading(true);

    const handleImportSuccess = async (noticeKey: string) => {
      showNotice.success(noticeKey);
      setUrl("");
      await performRobustRefresh();
    };

    try {
      // 尝试正常导入
      await importProfile(url);
      await handleImportSuccess("shared.feedback.notifications.importSuccess");
    } catch (initialErr) {
      console.warn("[ProfileImport] Initial import failed:", initialErr);

      showNotice.info("profiles.page.feedback.notifications.importRetry");
      try {
        // 使用自身代理尝试导入
        await importProfile(url, {
          with_proxy: false,
          self_proxy: true,
        });
        await handleImportSuccess(
          "shared.feedback.notifications.importWithClashProxy",
        );
      } catch (retryErr) {
        // 回退导入也失败
        showNotice.error(
          "profiles.page.feedback.notifications.importFail",
          String(retryErr),
        );
      }
    } finally {
      setDisabled(false);
      setLoading(false);
    }
  };

  // 强化的刷新策略
  const performRobustRefresh = async () => {
    let retryCount = 0;
    const maxRetries = 5;
    const baseDelay = 200;

    while (retryCount < maxRetries) {
      try {
        debugLog(`[ImportRefresh] Refreshing profile data, attempt ${retryCount + 1}`);

        // 强制刷新，绕过所有缓存
        await mutateProfiles(undefined, {
          revalidate: true,
          rollbackOnError: false,
        });

        // 等待状态稳定
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelay * (retryCount + 1)),
        );

        await onEnhance(false);
        return;
      } catch (error) {
        console.error(`[ImportRefresh] Refresh attempt ${retryCount + 1} failed:`, error);
        retryCount++;
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelay * retryCount),
        );
      }
    }

    // 所有重试失败后的最后尝试
    console.warn(`[ImportRefresh] Regular refresh failed; clearing cache and retrying`);
    try {
      // 清除SWR缓存并重新获取
      await mutate("getProfiles", getProfiles(), { revalidate: true });
      await onEnhance(false);
      showNotice.error(
        "profiles.page.feedback.notifications.importNeedsRefresh",
        3000,
      );
    } catch (finalError) {
      console.error(`[ImportRefresh] Final refresh attempt failed:`, finalError);
      showNotice.error(
        "profiles.page.feedback.notifications.importSuccess",
        5000,
      );
    }
  };

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (over) {
      if (active.id !== over.id) {
        await reorderProfile(active.id.toString(), over.id.toString());
        mutateProfiles();
      }
    }
  };

  const executeBackgroundTasks = useCallback(
    async (
      profile: string,
      sequence: number,
      abortController: AbortController,
    ) => {
      try {
        if (
          sequence === requestSequenceRef.current &&
          switchingProfileRef.current === profile &&
          !abortController.signal.aborted
        ) {
          await activateSelected();
          debugLog(`[Profile] Background processing completed, sequence: ${sequence}`);
        } else {
          debugProfileSwitch(
            "BACKGROUND_TASK_SKIPPED",
            profile,
            `序列号过期或被中断: ${sequence} vs ${requestSequenceRef.current}`,
          );
        }
      } catch (err: any) {
        console.warn("Failed to activate selected proxies:", err);
      }
    },
    [activateSelected],
  );

  const activateProfile = useCallback(
    async (profile: string, notifySuccess: boolean) => {
      if (profiles.current === profile && !notifySuccess) {
        debugLog(`[Profile] Target profile ${profile} is already active; skipping switch`);
        return;
      }

      const currentSequence = ++requestSequenceRef.current;
      debugProfileSwitch("NEW_REQUEST", profile, `Sequence: ${currentSequence}`);

      // 处理中断逻辑
      const previousSwitching = switchingProfileRef.current;
      if (previousSwitching && previousSwitching !== profile) {
        handleProfileInterrupt(previousSwitching, profile);
      }

      // 防止重复切换同一个profile
      if (switchingProfileRef.current === profile) {
        debugProfileSwitch("DUPLICATE_SWITCH_BLOCKED", profile);
        return;
      }

      // 初始化切换状态
      switchingProfileRef.current = profile;
      debugProfileSwitch("SWITCH_START", profile, `Sequence: ${currentSequence}`);

      const currentAbortController = new AbortController();
      abortControllerRef.current = currentAbortController;

      setActivatings((prev) => {
        if (prev.includes(profile)) return prev;
        return [...prev, profile];
      });

      try {
        debugLog(
          `[Profile] Switching to ${profile}, sequence: ${currentSequence}`,
        );

        // 检查请求有效性
        if (
          isRequestOutdated(currentSequence, requestSequenceRef, profile) ||
          isOperationAborted(currentAbortController, profile)
        ) {
          return;
        }

        // 执行切换请求
        const requestPromise = patchProfiles(
          { current: profile },
          currentAbortController.signal,
        );
        pendingRequestRef.current = requestPromise;

        const success = await requestPromise;

        if (pendingRequestRef.current === requestPromise) {
          pendingRequestRef.current = null;
        }

        // 再次检查有效性
        if (
          isRequestOutdated(currentSequence, requestSequenceRef, profile) ||
          isOperationAborted(currentAbortController, profile)
        ) {
          return;
        }

        // 完成切换
        await mutateLogs();
        closeAllConnections();

        if (notifySuccess && success) {
          showNotice.success(
            "profiles.page.feedback.notifications.profileSwitched",
            1000,
          );
        }

        debugLog(
          `[Profile] Switched to ${profile}, sequence: ${currentSequence}; starting background processing`,
        );

        // 延迟执行后台任务
        setTimeout(
          () =>
            executeBackgroundTasks(
              profile,
              currentSequence,
              currentAbortController,
            ),
          50,
        );
      } catch (err: any) {
        if (pendingRequestRef.current) {
          pendingRequestRef.current = null;
        }

        // 检查是否因为中断或过期而出错
        if (
          isOperationAborted(currentAbortController, profile) ||
          isRequestOutdated(currentSequence, requestSequenceRef, profile)
        ) {
          return;
        }

        console.error(`[Profile] Switch failed:`, err);
        showNotice.error(err, 4000);
      } finally {
        // 只有当前profile仍然是正在切换的profile且序列号匹配时才清理状态
        if (
          switchingProfileRef.current === profile &&
          currentSequence === requestSequenceRef.current
        ) {
          cleanupSwitchState(profile, currentSequence);
        } else {
          debugProfileSwitch(
            "CLEANUP_SKIPPED",
            profile,
            `序列号不匹配或已被接管: ${currentSequence} vs ${requestSequenceRef.current}`,
          );
        }
      }
    },
    [
      profiles,
      patchProfiles,
      mutateLogs,
      executeBackgroundTasks,
      handleProfileInterrupt,
      cleanupSwitchState,
    ],
  );
  const onSelect = async (current: string, force: boolean) => {
    // 阻止重复点击或已激活的profile
    if (switchingProfileRef.current === current) {
      debugProfileSwitch("DUPLICATE_CLICK_IGNORED", current);
      return;
    }

    if (!force && current === profiles.current) {
      debugProfileSwitch("ALREADY_CURRENT_IGNORED", current);
      return;
    }

    await activateProfile(current, true);
  };

  useEffect(() => {
    (async () => {
      if (current) {
        mutateProfiles();
        await activateProfile(current, false);
      }
    })();
  }, [current, activateProfile, mutateProfiles]);

  // 强制使用第一个 local 作为当前配置
  useEffect(() => {
    if (!firstLocalUid) return;
    if (profiles.current === firstLocalUid) return;
    if (switchingProfileRef.current) return;
    void activateProfile(firstLocalUid, false);
  }, [firstLocalUid, profiles.current, activateProfile]);

  const onEnhance = useLockFn(async (notifySuccess: boolean) => {
    if (switchingProfileRef.current) {
      debugLog(
        `[Profile] Profile switch already in progress (${switchingProfileRef.current}); skipping enhance`,
      );
      return;
    }

    const currentProfiles = currentActivatings();
    setActivatings((prev) => [...new Set([...prev, ...currentProfiles])]);

    try {
      await enhanceProfiles();
      mutateLogs();
      if (notifySuccess) {
        showNotice.success(
          "profiles.page.feedback.notifications.profileReactivated",
          1000,
        );
      }
    } catch (err: any) {
      showNotice.error(err, 3000);
    } finally {
      // 保留正在切换的profile，清除其他状态
      setActivatings((prev) =>
        prev.filter((id) => id === switchingProfileRef.current),
      );
    }
  });

  const onDelete = useLockFn(async (uid: string) => {
    const wasCurrent = profiles.current === uid;
    const wasMergeSource =
      mergeTargetIndex >= 0 &&
      profileItems
        .slice(mergeTargetIndex + 1)
        .some((item) => item.uid === uid && item.type === "remote");
    try {
      setActivatings([...(wasCurrent ? currentActivatings() : []), uid]);
      await deleteProfile(uid);
      if (mergeInclusion[uid] !== undefined) {
        setMergeInclusion((prev) => {
          const next = { ...prev };
          delete next[uid];
          localStorage.setItem(MERGE_INCLUSION_STORAGE_KEY, JSON.stringify(next));
          return next;
        });
      }
      mutateProfiles();
      mutateLogs();
      if (wasCurrent && firstLocalUid) {
        await activateProfile(firstLocalUid, false);
      }
      if (wasMergeSource) {
        await onGenerateMergedProfile();
      } else if (wasCurrent) {
        await onEnhance(false);
      }
    } catch (err: any) {
      showNotice.error(err);
    } finally {
      setActivatings([]);
    }
  });

  const setLoadingCache = useSetLoadingCache();
  const onUpdateAll = useLockFn(async () => {
    await updateAllRemoteAndMerge("手动刷新");
  });

  const onCopyLink = async () => {
    const text = await readText();
    if (text) setUrl(text);
  };

  useEffect(() => {
    localStorage.setItem(
      GLOBAL_UPDATE_INTERVAL_STORAGE_KEY,
      String(globalUpdateHours),
    );
  }, [globalUpdateHours]);

  useEffect(() => {
    disablePerProfileAutoUpdate();
  }, [disablePerProfileAutoUpdate]);

  useEffect(() => {
    const intervalMs = globalUpdateHours * 60 * 60 * 1000;
    const now = Date.now();
    const appliedInterval = Number(
      localStorage.getItem(GLOBAL_UPDATE_INTERVAL_APPLIED_STORAGE_KEY) || 0,
    );
    const intervalChanged = appliedInterval !== globalUpdateHours;
    let timeoutId: number | undefined;
    let disposed = false;

    const schedule = (baseNow: number) => {
      if (disposed) return;

      let nextUpdateAt = Number(
        localStorage.getItem(GLOBAL_UPDATE_NEXT_AT_STORAGE_KEY) || 0,
      );
      if (!Number.isFinite(nextUpdateAt) || nextUpdateAt <= 0 || intervalChanged) {
        nextUpdateAt = baseNow + intervalMs;
      }

      if (nextUpdateAt <= baseNow) {
        void updateAllRemoteAndMerge("定时任务(启动补偿)");
        nextUpdateAt = baseNow + intervalMs;
      }

      localStorage.setItem(
        GLOBAL_UPDATE_INTERVAL_APPLIED_STORAGE_KEY,
        String(globalUpdateHours),
      );
      localStorage.setItem(
        GLOBAL_UPDATE_NEXT_AT_STORAGE_KEY,
        String(nextUpdateAt),
      );

      const delay = Math.max(1000, nextUpdateAt - baseNow);
      timeoutId = window.setTimeout(() => {
        void updateAllRemoteAndMerge("定时任务");
        schedule(Date.now() + 1000);
      }, delay);
    };

    schedule(now);

    return () => {
      disposed = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [globalUpdateHours, updateAllRemoteAndMerge]);

  const mode = useThemeMode();
  const isLight = mode === "light";
  const dividercolor = isLight
    ? "rgba(0, 0, 0, 0.06)"
    : "rgba(255, 255, 255, 0.06)";

  // 监听后端配置变更
  useEffect(() => {
    let unlistenPromise: Promise<() => void> | undefined;
    let lastProfileId: string | null = null;
    let lastUpdateTime = 0;
    const debounceDelay = 200;

    let refreshTimer: number | null = null;

    const setupListener = async () => {
      unlistenPromise = listen<string>("profile-changed", (event) => {
        const newProfileId = event.payload;
        const now = Date.now();

        debugLog(`[Profile] Received profile change event: ${newProfileId}`);

        if (
          lastProfileId === newProfileId &&
          now - lastUpdateTime < debounceDelay
        ) {
          debugLog(`[Profile] Duplicate event suppressed`);
          return;
        }

        lastProfileId = newProfileId;
        lastUpdateTime = now;

        debugLog(`[Profile] Refreshing profile data`);

        if (refreshTimer !== null) {
          window.clearTimeout(refreshTimer);
        }

        // 使用异步调度避免阻塞事件处理
        refreshTimer = window.setTimeout(() => {
          mutateProfiles().catch((error) => {
            console.error("[Profile] Failed to refresh profile data:", error);
          });
          refreshTimer = null;
        }, 0);
      });
    };

    setupListener();

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      unlistenPromise?.then((unlisten) => unlisten()).catch(console.error);
    };
  }, [mutateProfiles]);

  // 组件卸载时清理中断控制器
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        debugProfileSwitch("COMPONENT_UNMOUNT_CLEANUP", "all");
      }
    };
  }, []);

  return (
    <BasePage
      full
      title={t("profiles.page.title")}
      contentStyle={{ height: "100%" }}
      header={
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton
            size="small"
            color="inherit"
            title={t("profiles.page.actions.updateAll")}
            onClick={onUpdateAll}
          >
            <RefreshRounded />
          </IconButton>

          <IconButton
            size="small"
            color="inherit"
            title={t("profiles.page.actions.viewRuntimeConfig")}
            onClick={() => configRef.current?.open()}
          >
            <TextSnippetOutlined />
          </IconButton>

          <RuntimeYamlTransferActions
            onImported={async () => {
              await mutateProfiles();
              await mutateLogs();
            }}
          />

          <IconButton
            size="small"
            color="inherit"
            title="Open Clash data directory"
            onClick={() => void openAppDir()}
          >
            <FolderOpenRounded />
          </IconButton>

          <IconButton
            size="small"
            color="inherit"
            title="Generate merged local profile with backup"
            onClick={() => void onGenerateMergedProfile()}
          >
            <DataObjectRounded />
          </IconButton>

          <Tooltip
            title={`Automatically update remote profiles every ${globalUpdateHours === 168 ? "week" : `${globalUpdateHours} hours`}`}
          >
            <FormControl size="small" sx={{ minWidth: 64 }}>
              <Select
                value={globalUpdateHours}
                inputProps={{
                  "aria-label": "Automatic profile update schedule",
                }}
                renderValue={(hours) =>
                  Number(hours) === 168 ? "1w" : `${hours}h`
                }
                onChange={(event) =>
                  setGlobalUpdateHours(Number(event.target.value))
                }
              >
                {GLOBAL_UPDATE_INTERVAL_OPTIONS.map((hours) => (
                  <MenuItem key={hours} value={hours}>
                    {hours === 168 ? "Every week" : `Every ${hours} hours`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Tooltip>

          {(error || isStale) && (
            <IconButton
              size="small"
              color="warning"
            title="Data appears invalid; click to force refresh"
              onClick={onEmergencyRefresh}
              sx={{
                animation: "pulse 2s infinite",
                "@keyframes pulse": {
                  "0%": { opacity: 1 },
                  "50%": { opacity: 0.5 },
                  "100%": { opacity: 1 },
                },
              }}
            >
              <ClearRounded />
            </IconButton>
          )}
        </Box>
      }
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          pt: 1,
          mb: 0.5,
          mx: "10px",
          height: "36px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <BaseStyledTextField
          value={url}
          variant="outlined"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) {
              return;
            }
            if (!url || disabled || loading) {
              return;
            }
            event.preventDefault();
            void onImport();
          }}
          placeholder={t("profiles.page.importForm.placeholder")}
          slotProps={{
            input: {
              sx: { pr: 1 },
              endAdornment: !url ? (
                <IconButton
                  size="small"
                  sx={{ p: 0.5 }}
                  title={t("profiles.page.importForm.actions.paste")}
                  onClick={onCopyLink}
                >
                  <ContentPasteRounded fontSize="inherit" />
                </IconButton>
              ) : (
                <IconButton
                  size="small"
                  sx={{ p: 0.5 }}
                  title={t("shared.actions.clear")}
                  onClick={() => setUrl("")}
                >
                  <ClearRounded fontSize="inherit" />
                </IconButton>
              ),
            },
          }}
        />
        <LoadingButton
          disabled={!url || disabled}
          loading={loading}
          variant="contained"
          size="small"
          sx={{ borderRadius: "6px" }}
          onClick={onImport}
        >
          {t("profiles.page.actions.import")}
        </LoadingButton>
        <Button
          variant="contained"
          size="small"
          sx={{ borderRadius: "6px" }}
          onClick={() => viewerRef.current?.create()}
        >
          {t("shared.actions.new")}
        </Button>
      </Stack>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <Box
          sx={{
            pl: "10px",
            pr: "10px",
            height: "calc(100% - 48px)",
            overflowY: "auto",
          }}
        >
          <Box sx={{ mb: 1.5 }}>
            <Grid container spacing={{ xs: 1, lg: 1 }}>
              <SortableContext
                items={profileItems.map((x) => {
                  return x.uid;
                })}
              >
                {profileItems.map((item, index) => (
                  <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={item.file}>
                    <ProfileItem
                      id={item.uid}
                      selected={firstLocalUid === item.uid}
                      activating={activatings.includes(item.uid)}
                      itemData={item}
                      allowProfileSelect={false}
                      mergeIncludeEnabled={
                        item.type === "remote" && index > mergeTargetIndex
                      }
                      mergeIncluded={mergeInclusion[item.uid] !== false}
                      onMergeIncludedChange={(included) =>
                        onMergeInclusionChange(item.uid, included)
                      }
                      onSelect={() => { }}
                      onEdit={() => viewerRef.current?.edit(item)}
                      onSave={async (prev, curr) => {
                        if (prev !== curr && firstLocalUid === item.uid) {
                          await onEnhance(false);
                          //  await restartCore();
                          //   Notice.success(t("settings.feedback.notifications.clash.restartSuccess"), 1000);
                        }
                      }}
                      onDelete={() => onDelete(item.uid)}
                      batchMode={false}
                      isSelected={false}
                      onSelectionChange={() => { }}
                    />
                  </Grid>
                ))}
              </SortableContext>
            </Grid>
          </Box>
          <Divider
            variant="middle"
            flexItem
            sx={{ width: `calc(100% - 32px)`, borderColor: dividercolor }}
          ></Divider>
          <Box sx={{ mt: 1.5, mb: "10px" }}>
            <Grid container spacing={{ xs: 1, lg: 1 }}>
              <Grid size={{ xs: 12, sm: 6, md: 6, lg: 6 }}>
                <ProfileMore id="Merge" />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 6, lg: 6 }}>
                <ProfileMore
                  id="Script"
                  logInfo={chainLogs["Script"]}
                  onSave={async () => {
                    await mutateLogs();
                  }}
                />
              </Grid>
            </Grid>
          </Box>
        </Box>
        <DragOverlay />
      </DndContext>

      <ProfileViewer
        ref={viewerRef}
        onChange={async (isActivating) => {
          mutateProfiles();
          // 只有更改当前激活的配置时才触发全局重新加载
          if (isActivating) {
            await onEnhance(false);
          }
        }}
      />
      <ConfigViewer ref={configRef} />
    </BasePage>
  );
};

export default ProfilePage;
