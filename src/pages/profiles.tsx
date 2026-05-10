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
  InputLabel,
  MenuItem,
  TextField,
  Select,
  Stack,
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
  patchProfile,
  readProfileFile,
  reorderProfile,
  saveProfileFile,
  updateProfile,
} from "@/services/cmds";
import { showNotice } from "@/services/notice-service";
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
// 仅按节点名里的中文国家/地区关键字识别归属，避免英文缩写误命中（如 "in" 命中 "Origin"）。
// 顺序敏感（first-match）：当一个关键字是另一个的子串时，长的必须放前面，否则会被错判。
//   - "印度尼西亚" / "印尼" ⊃ "印度"      → ID 在 IN 前
//   - "白俄罗斯" ⊃ "俄罗斯"               → BY 在 RU 前
//   - "罗马尼亚" ⊃ "罗马"（意大利城市）   → RO 在 IT 前
const COUNTRY_FLAG_KEYWORDS: Array<{ flag: string; keywords: string[] }> = [
  // 大中华
  { flag: "🇭🇰", keywords: ["香港"] },
  { flag: "🇲🇴", keywords: ["澳门"] },
  { flag: "🇹🇼", keywords: ["台湾", "台北", "高雄", "台中", "台南"] },
  { flag: "🇨🇳", keywords: ["中国", "大陆", "回国", "上海", "北京", "广州", "深圳", "成都", "杭州"] },

  // 东亚
  { flag: "🇯🇵", keywords: ["日本", "东京", "大阪", "名古屋", "京都", "福冈", "札幌", "横滨"] },
  { flag: "🇰🇷", keywords: ["韩国", "南韩", "首尔", "釜山"] },
  { flag: "🇲🇳", keywords: ["蒙古"] },

  // 东南亚（印尼必须在印度之前）
  { flag: "🇸🇬", keywords: ["新加坡", "狮城"] },
  { flag: "🇮🇩", keywords: ["印度尼西亚", "印尼", "雅加达", "巴厘岛"] },
  { flag: "🇲🇾", keywords: ["马来西亚", "吉隆坡"] },
  { flag: "🇹🇭", keywords: ["泰国", "曼谷"] },
  { flag: "🇻🇳", keywords: ["越南", "胡志明", "河内"] },
  { flag: "🇵🇭", keywords: ["菲律宾", "马尼拉"] },
  { flag: "🇰🇭", keywords: ["柬埔寨", "金边"] },
  { flag: "🇱🇦", keywords: ["老挝"] },
  { flag: "🇲🇲", keywords: ["缅甸"] },

  // 南亚
  { flag: "🇮🇳", keywords: ["印度", "孟买", "新德里", "班加罗尔"] },
  { flag: "🇵🇰", keywords: ["巴基斯坦"] },
  { flag: "🇧🇩", keywords: ["孟加拉"] },
  { flag: "🇱🇰", keywords: ["斯里兰卡"] },

  // 中亚 / 西亚
  { flag: "🇰🇿", keywords: ["哈萨克斯坦", "哈萨克"] },
  { flag: "🇦🇪", keywords: ["阿联酋", "迪拜", "阿布扎比"] },
  { flag: "🇸🇦", keywords: ["沙特"] },
  { flag: "🇶🇦", keywords: ["卡塔尔"] },
  { flag: "🇮🇱", keywords: ["以色列"] },
  { flag: "🇮🇷", keywords: ["伊朗"] },
  { flag: "🇹🇷", keywords: ["土耳其", "伊斯坦布尔"] },

  // 东欧（白俄罗斯必须在俄罗斯之前）
  { flag: "🇧🇾", keywords: ["白俄罗斯"] },
  { flag: "🇷🇺", keywords: ["俄罗斯", "莫斯科", "圣彼得堡"] },
  { flag: "🇺🇦", keywords: ["乌克兰"] },

  // 中欧 / 西欧（罗马尼亚必须在意大利之前）
  { flag: "🇷🇴", keywords: ["罗马尼亚"] },
  { flag: "🇩🇪", keywords: ["德国", "法兰克福", "柏林", "慕尼黑", "汉堡"] },
  { flag: "🇫🇷", keywords: ["法国", "巴黎", "马赛"] },
  { flag: "🇬🇧", keywords: ["英国", "伦敦", "曼彻斯特"] },
  { flag: "🇮🇪", keywords: ["爱尔兰", "都柏林"] },
  { flag: "🇳🇱", keywords: ["荷兰", "阿姆斯特丹"] },
  { flag: "🇧🇪", keywords: ["比利时", "布鲁塞尔"] },
  { flag: "🇱🇺", keywords: ["卢森堡"] },
  { flag: "🇨🇭", keywords: ["瑞士", "苏黎世", "日内瓦"] },
  { flag: "🇦🇹", keywords: ["奥地利", "维也纳"] },
  { flag: "🇮🇹", keywords: ["意大利", "罗马", "米兰"] },
  { flag: "🇪🇸", keywords: ["西班牙", "马德里", "巴塞罗那"] },
  { flag: "🇵🇹", keywords: ["葡萄牙", "里斯本"] },
  { flag: "🇬🇷", keywords: ["希腊", "雅典"] },

  // 北欧
  { flag: "🇸🇪", keywords: ["瑞典", "斯德哥尔摩"] },
  { flag: "🇳🇴", keywords: ["挪威", "奥斯陆"] },
  { flag: "🇫🇮", keywords: ["芬兰", "赫尔辛基"] },
  { flag: "🇩🇰", keywords: ["丹麦", "哥本哈根"] },
  { flag: "🇮🇸", keywords: ["冰岛"] },

  // 中东欧
  { flag: "🇵🇱", keywords: ["波兰", "华沙"] },
  { flag: "🇨🇿", keywords: ["捷克"] },
  { flag: "🇸🇰", keywords: ["斯洛伐克"] },
  { flag: "🇸🇮", keywords: ["斯洛文尼亚"] },
  { flag: "🇭🇺", keywords: ["匈牙利", "布达佩斯"] },
  { flag: "🇧🇬", keywords: ["保加利亚"] },
  { flag: "🇷🇸", keywords: ["塞尔维亚"] },
  { flag: "🇭🇷", keywords: ["克罗地亚"] },

  // 北美
  { flag: "🇺🇸", keywords: ["美国", "纽约", "洛杉矶", "圣何塞", "阿什本", "华盛顿", "波士顿", "迈阿密", "西雅图", "芝加哥", "达拉斯", "休斯顿", "丹佛", "凤凰城", "圣地亚哥", "夏威夷", "硅谷"] },
  { flag: "🇨🇦", keywords: ["加拿大", "多伦多", "温哥华", "蒙特利尔"] },
  { flag: "🇲🇽", keywords: ["墨西哥"] },

  // 南美
  { flag: "🇧🇷", keywords: ["巴西", "圣保罗", "里约"] },
  { flag: "🇦🇷", keywords: ["阿根廷"] },
  { flag: "🇨🇱", keywords: ["智利"] },
  { flag: "🇨🇴", keywords: ["哥伦比亚"] },
  { flag: "🇵🇪", keywords: ["秘鲁"] },

  // 非洲
  { flag: "🇿🇦", keywords: ["南非", "约翰内斯堡"] },
  { flag: "🇪🇬", keywords: ["埃及", "开罗"] },
  { flag: "🇳🇬", keywords: ["尼日利亚"] },
  { flag: "🇰🇪", keywords: ["肯尼亚"] },
  { flag: "🇲🇦", keywords: ["摩洛哥"] },

  // 大洋洲
  { flag: "🇦🇺", keywords: ["澳大利亚", "澳洲", "悉尼", "墨尔本", "布里斯班", "珀斯"] },
  { flag: "🇳🇿", keywords: ["新西兰", "奥克兰"] },
];

/**
 * 仅根据节点名里的中文关键字识别归属。
 * 命中返回正确的国旗 Emoji；未命中返回 null，调用方据此过滤掉这个节点。
 */
const resolveFlag = (proxyName: string): string | null => {
  for (const rule of COUNTRY_FLAG_KEYWORDS) {
    if (rule.keywords.some((keyword) => proxyName.includes(keyword))) {
      return rule.flag;
    }
  }
  return null;
};

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
const CUSTOM_PROXY_ORDER_STORAGE_KEY = "profiles.customProxyOrder";
const DEFAULT_CUSTOM_PROXY_ORDER = ["🇭🇰", "🇯🇵", "🇸🇬", "🇹🇼", "🇺🇸"] as const;

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
  const [customProxyOrderText, setCustomProxyOrderText] = useState<string>(() => {
    const saved = localStorage.getItem(CUSTOM_PROXY_ORDER_STORAGE_KEY);
    if (saved && saved.trim()) return saved;
    return DEFAULT_CUSTOM_PROXY_ORDER.join(",");
  });

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
      debugProfileSwitch("SWITCH_END", profile, `序列号: ${sequence}`);
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
    const localItems = profileItems.filter((item) => item.type === "local");
    const backups = localItems.filter((item) => /^Local-backup-\d+$/.test(item.name || ""));
    backups.sort((a, b) => (b.updated || 0) - (a.updated || 0));

    // 删除多余备份，仅保留最近两个（第三个将由本次新建）
    const keep = backups.slice(0, 2);
    const remove = backups.slice(2);
    await Promise.allSettled(remove.map((item) => deleteProfile(item.uid)));

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
        desc: "auto backup before merge",
        url: "",
        option: {
          with_proxy: false,
          self_proxy: false,
        },
      },
      targetRaw,
    );
  };

  const parseCustomProxyOrder = useCallback(() => {
    return customProxyOrderText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, [customProxyOrderText]);

  const sortProxiesByCustomOrder = useCallback(
    (proxies: any[]) => {
      const customOrder = parseCustomProxyOrder();
      const orderMap = new Map(customOrder.map((flag, index) => [flag, index]));

      // 未列在自定义排序里的 flag，按它们「在源里首次出现」的顺序追加排序键。
      // 这样即便没指定，同一个国家（如澳门、巴西）的节点也会连续聚在一起，不再交叉混排。
      const fallbackOrderMap = new Map<string, number>();
      let nextFallbackOrder = customOrder.length;

      const decorated = proxies.map((proxy, originalIndex) => {
        const flag = resolveFlag(String(proxy?.name || "")) ?? "";
        let groupOrder = orderMap.get(flag);
        if (groupOrder === undefined) {
          const cached = fallbackOrderMap.get(flag);
          if (cached === undefined) {
            groupOrder = nextFallbackOrder;
            fallbackOrderMap.set(flag, nextFallbackOrder);
            nextFallbackOrder += 1;
          } else {
            groupOrder = cached;
          }
        }
        return { proxy, originalIndex, groupOrder };
      });

      decorated.sort((a, b) => {
        if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
        return a.originalIndex - b.originalIndex;
      });

      return decorated.map((item) => item.proxy);
    },
    [parseCustomProxyOrder],
  );

  const onGenerateMergedProfile = useLockFn(async () => {
    showNotice.info("开始执行配置合并", 1500);
    const items = profileItems;
    const targetIndex = items.findIndex((item) => item.type === "local");
    if (targetIndex === -1) {
      showNotice.error("No local target profile found");
      return;
    }

    const targetProfile = items[targetIndex];
    const sourceProfiles = items
      .slice(targetIndex + 1)
      .filter((item) => item.type === "remote");

    if (!sourceProfiles.length) {
      showNotice.error("No remote source profiles found after target local profile");
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
        const sourceProxies = sortProxiesByCustomOrder(sourceProxiesRaw);

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
            `[订阅合并] ${sourceDisplayName}：跳过 ${droppedCount} 个未匹配中文国家关键字的节点`,
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
      if (profiles.current === targetProfile.uid) {
        await enhanceProfiles();
      }
      await mutateProfiles();
      showNotice.success(`合并完成：已处理 ${sourceProfiles.length} 个远程配置`, 3000);
    } catch (err: any) {
      showNotice.error(`Failed to generate merged profile: ${String(err?.message || err)}`);
    }
  });

  const updateAllRemoteAndMerge = useLockFn(async (source: string) => {
    showNotice.info(`${source}：开始更新远程规则`, 1500);
    const throttleMutate = throttle(mutateProfiles, 2000, {
      trailing: true,
    });
    const updateOne = async (uid: string) => {
      try {
        await updateProfile(uid);
        throttleMutate();
      } catch (err: any) {
        console.error(`更新订阅 ${uid} 失败:`, err);
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

    showNotice.success(`${source}：远程规则更新完成，开始合并`, 2000);
    await onGenerateMergedProfile();
  });

  // 添加紧急恢复功能
  const onEmergencyRefresh = useLockFn(async () => {
    debugLog("[紧急刷新] 开始强制刷新所有数据");

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
      console.error("[紧急刷新] 失败:", error);
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
  const profileItems = useMemo(() => {
    const items = profiles.items || [];

    const type1 = ["local", "remote"];

    return items.filter((i) => i && type1.includes(i.type!));
  }, [profiles]);

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
      console.warn("[订阅导入] 首次导入失败:", initialErr);

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
        debugLog(`[导入刷新] 第${retryCount + 1}次尝试刷新配置数据`);

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
        console.error(`[导入刷新] 第${retryCount + 1}次刷新失败:`, error);
        retryCount++;
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelay * retryCount),
        );
      }
    }

    // 所有重试失败后的最后尝试
    console.warn(`[导入刷新] 常规刷新失败，尝试清除缓存重新获取`);
    try {
      // 清除SWR缓存并重新获取
      await mutate("getProfiles", getProfiles(), { revalidate: true });
      await onEnhance(false);
      showNotice.error(
        "profiles.page.feedback.notifications.importNeedsRefresh",
        3000,
      );
    } catch (finalError) {
      console.error(`[导入刷新] 最终刷新尝试失败:`, finalError);
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
          debugLog(`[Profile] 后台处理完成，序列号: ${sequence}`);
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
        debugLog(`[Profile] 目标profile ${profile} 已经是当前配置，跳过切换`);
        return;
      }

      const currentSequence = ++requestSequenceRef.current;
      debugProfileSwitch("NEW_REQUEST", profile, `序列号: ${currentSequence}`);

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
      debugProfileSwitch("SWITCH_START", profile, `序列号: ${currentSequence}`);

      const currentAbortController = new AbortController();
      abortControllerRef.current = currentAbortController;

      setActivatings((prev) => {
        if (prev.includes(profile)) return prev;
        return [...prev, profile];
      });

      try {
        debugLog(
          `[Profile] 开始切换到: ${profile}，序列号: ${currentSequence}`,
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
          `[Profile] 切换到 ${profile} 完成，序列号: ${currentSequence}，开始后台处理`,
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

        console.error(`[Profile] 切换失败:`, err);
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

  const onEnhance = useLockFn(async (notifySuccess: boolean) => {
    if (switchingProfileRef.current) {
      debugLog(
        `[Profile] 有profile正在切换中(${switchingProfileRef.current})，跳过enhance操作`,
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
    const current = profiles.current === uid;
    try {
      setActivatings([...(current ? currentActivatings() : []), uid]);
      await deleteProfile(uid);
      mutateProfiles();
      mutateLogs();
      if (current) {
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
    localStorage.setItem(CUSTOM_PROXY_ORDER_STORAGE_KEY, customProxyOrderText);
  }, [customProxyOrderText]);

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

        debugLog(`[Profile] 收到配置变更事件: ${newProfileId}`);

        if (
          lastProfileId === newProfileId &&
          now - lastUpdateTime < debounceDelay
        ) {
          debugLog(`[Profile] 重复事件被防抖，跳过`);
          return;
        }

        lastProfileId = newProfileId;
        lastUpdateTime = now;

        debugLog(`[Profile] 执行配置数据刷新`);

        if (refreshTimer !== null) {
          window.clearTimeout(refreshTimer);
        }

        // 使用异步调度避免阻塞事件处理
        refreshTimer = window.setTimeout(() => {
          mutateProfiles().catch((error) => {
            console.error("[Profile] 配置数据刷新失败:", error);
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

          <IconButton
            size="small"
            color="inherit"
            title="Generate merged local profile with backup"
            onClick={onGenerateMergedProfile}
          >
            <DataObjectRounded />
          </IconButton>

          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel id="global-update-hours-label">定时(小时)</InputLabel>
            <Select
              labelId="global-update-hours-label"
              value={globalUpdateHours}
              label="定时(小时)"
              onChange={(event) =>
                setGlobalUpdateHours(Number(event.target.value))
              }
            >
              {GLOBAL_UPDATE_INTERVAL_OPTIONS.map((hours) => (
                <MenuItem key={hours} value={hours}>
                  {hours === 168 ? "168 (24*7)" : hours}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            size="small"
            label="节点排序"
            value={customProxyOrderText}
            onChange={(event) => setCustomProxyOrderText(event.target.value)}
            placeholder="🇭🇰,🇯🇵,🇸🇬,🇹🇼,🇺🇸"
            sx={{ minWidth: 240 }}
          />

          {(error || isStale) && (
            <IconButton
              size="small"
              color="warning"
              title="数据异常，点击强制刷新"
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
                {profileItems.map((item) => (
                  <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={item.file}>
                    <ProfileItem
                      id={item.uid}
                      selected={profiles.current === item.uid}
                      activating={activatings.includes(item.uid)}
                      itemData={item}
                      onSelect={(f) => onSelect(item.uid, f)}
                      onEdit={() => viewerRef.current?.edit(item)}
                      onSave={async (prev, curr) => {
                        if (prev !== curr && profiles.current === item.uid) {
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
                <ProfileMore
                  id="Merge"
                  onSave={async (prev, curr) => {
                    if (prev !== curr) {
                      await onEnhance(false);
                    }
                  }}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 6, lg: 6 }}>
                <ProfileMore
                  id="Script"
                  logInfo={chainLogs["Script"]}
                  onSave={async (prev, curr) => {
                    if (prev !== curr) {
                      await onEnhance(false);
                    }
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
