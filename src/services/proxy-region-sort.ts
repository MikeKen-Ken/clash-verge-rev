import { getConnectivitySuccessCount } from "./proxy-connectivity-stats";

export const CUSTOM_PROXY_ORDER_STORAGE_KEY = "profiles.customProxyOrder";

export const DEFAULT_CUSTOM_PROXY_ORDER = [
  "🇭🇰",
  "🇯🇵",
  "🇸🇬",
  "🇹🇼",
  "🇺🇸",
] as const;

const COUNTRY_FLAG_KEYWORDS: Array<{ flag: string; keywords: string[] }> = [
  { flag: "🇭🇰", keywords: ["香港"] },
  { flag: "🇲🇴", keywords: ["澳门"] },
  { flag: "🇹🇼", keywords: ["台湾", "台北", "高雄", "台中", "台南"] },
  { flag: "🇨🇳", keywords: ["中国", "大陆", "回国", "上海", "北京", "广州", "深圳", "成都", "杭州"] },
  { flag: "🇯🇵", keywords: ["日本", "东京", "大阪", "名古屋", "京都", "福冈", "札幌", "横滨"] },
  { flag: "🇰🇷", keywords: ["韩国", "南韩", "首尔", "釜山"] },
  { flag: "🇲🇳", keywords: ["蒙古"] },
  { flag: "🇸🇬", keywords: ["新加坡", "狮城"] },
  { flag: "🇮🇩", keywords: ["印度尼西亚", "印尼", "雅加达", "巴厘岛"] },
  { flag: "🇲🇾", keywords: ["马来西亚", "吉隆坡"] },
  { flag: "🇹🇭", keywords: ["泰国", "曼谷"] },
  { flag: "🇻🇳", keywords: ["越南", "胡志明", "河内"] },
  { flag: "🇵🇭", keywords: ["菲律宾", "马尼拉"] },
  { flag: "🇰🇭", keywords: ["柬埔寨", "金边"] },
  { flag: "🇱🇦", keywords: ["老挝"] },
  { flag: "🇲🇲", keywords: ["缅甸"] },
  { flag: "🇮🇳", keywords: ["印度", "孟买", "新德里", "班加罗尔"] },
  { flag: "🇵🇰", keywords: ["巴基斯坦"] },
  { flag: "🇧🇩", keywords: ["孟加拉"] },
  { flag: "🇱🇰", keywords: ["斯里兰卡"] },
  { flag: "🇰🇿", keywords: ["哈萨克斯坦", "哈萨克"] },
  { flag: "🇦🇪", keywords: ["阿联酋", "迪拜", "阿布扎比"] },
  { flag: "🇸🇦", keywords: ["沙特"] },
  { flag: "🇶🇦", keywords: ["卡塔尔"] },
  { flag: "🇮🇱", keywords: ["以色列"] },
  { flag: "🇮🇷", keywords: ["伊朗"] },
  { flag: "🇹🇷", keywords: ["土耳其", "伊斯坦布尔"] },
  { flag: "🇧🇾", keywords: ["白俄罗斯"] },
  { flag: "🇷🇺", keywords: ["俄罗斯", "莫斯科", "圣彼得堡"] },
  { flag: "🇺🇦", keywords: ["乌克兰"] },
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
  { flag: "🇸🇪", keywords: ["瑞典", "斯德哥尔摩"] },
  { flag: "🇳🇴", keywords: ["挪威", "奥斯陆"] },
  { flag: "🇫🇮", keywords: ["芬兰", "赫尔辛基"] },
  { flag: "🇩🇰", keywords: ["丹麦", "哥本哈根"] },
  { flag: "🇮🇸", keywords: ["冰岛"] },
  { flag: "🇵🇱", keywords: ["波兰", "华沙"] },
  { flag: "🇨🇿", keywords: ["捷克"] },
  { flag: "🇸🇰", keywords: ["斯洛伐克"] },
  { flag: "🇸🇮", keywords: ["斯洛文尼亚"] },
  { flag: "🇭🇺", keywords: ["匈牙利", "布达佩斯"] },
  { flag: "🇧🇬", keywords: ["保加利亚"] },
  { flag: "🇷🇸", keywords: ["塞尔维亚"] },
  { flag: "🇭🇷", keywords: ["克罗地亚"] },
  { flag: "🇺🇸", keywords: ["美国", "纽约", "洛杉矶", "圣何塞", "阿什本", "华盛顿", "波士顿", "迈阿密", "西雅图", "芝加哥", "达拉斯", "休斯顿", "丹佛", "凤凰城", "圣地亚哥", "夏威夷", "硅谷"] },
  { flag: "🇨🇦", keywords: ["加拿大", "多伦多", "温哥华", "蒙特利尔"] },
  { flag: "🇲🇽", keywords: ["墨西哥"] },
  { flag: "🇧🇷", keywords: ["巴西", "圣保罗", "里约"] },
  { flag: "🇦🇷", keywords: ["阿根廷"] },
  { flag: "🇨🇱", keywords: ["智利"] },
  { flag: "🇨🇴", keywords: ["哥伦比亚"] },
  { flag: "🇵🇪", keywords: ["秘鲁"] },
  { flag: "🇿🇦", keywords: ["南非", "约翰内斯堡"] },
  { flag: "🇪🇬", keywords: ["埃及", "开罗"] },
  { flag: "🇳🇬", keywords: ["尼日利亚"] },
  { flag: "🇰🇪", keywords: ["肯尼亚"] },
  { flag: "🇲🇦", keywords: ["摩洛哥"] },
  { flag: "🇦🇺", keywords: ["澳大利亚", "澳洲", "悉尼", "墨尔本", "布里斯班", "珀斯"] },
  { flag: "🇳🇿", keywords: ["新西兰", "奥克兰"] },
];

const ALL_REGION_FLAGS = COUNTRY_FLAG_KEYWORDS.map((rule) => rule.flag);

/** 仅根据节点名里的中文关键字识别归属；未命中返回 null */
export function resolveFlag(proxyName: string): string | null {
  for (const rule of COUNTRY_FLAG_KEYWORDS) {
    if (rule.keywords.some((keyword) => proxyName.includes(keyword))) {
      return rule.flag;
    }
  }
  return null;
}

/** 优先匹配节点名前缀的地区 emoji（如 🇭🇰 ✅ 01） */
export function resolveRegionFlag(proxyName: string): string {
  const trimmed = proxyName.trim();
  for (const flag of ALL_REGION_FLAGS) {
    if (trimmed.startsWith(flag)) return flag;
  }
  return resolveFlag(trimmed) ?? "";
}

/** 订阅组标识：节点名中地区 emoji 后的第一个 token（如 ✅、❤️、💸） */
export function resolveSubscriptionGroup(proxyName: string): string {
  let rest = proxyName.trim();
  for (const flag of ALL_REGION_FLAGS) {
    if (rest.startsWith(flag)) {
      rest = rest.slice(flag.length).trim();
      break;
    }
  }
  if (!rest) return "";
  return rest.split(/\s+/)[0] ?? "";
}

export function parseCustomProxyOrderText(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadCustomProxyOrderFromStorage(): string[] {
  if (typeof window === "undefined") {
    return [...DEFAULT_CUSTOM_PROXY_ORDER];
  }
  try {
    const saved = localStorage.getItem(CUSTOM_PROXY_ORDER_STORAGE_KEY);
    if (saved && saved.trim()) {
      const parsed = parseCustomProxyOrderText(saved);
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // ignore
  }
  return [...DEFAULT_CUSTOM_PROXY_ORDER];
}

export interface ProxySortContext {
  customOrder: string[];
  subscriptionOrder: Map<string, number>;
  regionFallbackOrder: Map<string, number>;
}

export function buildProxySortContext<T>(
  items: T[],
  customOrder: string[],
  getName: (item: T) => string,
): ProxySortContext {
  const subscriptionOrder = new Map<string, number>();
  const regionFallbackOrder = new Map<string, number>();
  let nextSubscriptionOrder = 0;
  let nextRegionFallback = customOrder.length;

  for (const item of items) {
    const name = getName(item);
    const subscription = resolveSubscriptionGroup(name);
    if (!subscriptionOrder.has(subscription)) {
      subscriptionOrder.set(subscription, nextSubscriptionOrder);
      nextSubscriptionOrder += 1;
    }

    const flag = resolveRegionFlag(name);
    if (!flag) continue;
    if (customOrder.includes(flag) || regionFallbackOrder.has(flag)) continue;
    regionFallbackOrder.set(flag, nextRegionFallback);
    nextRegionFallback += 1;
  }

  return { customOrder, subscriptionOrder, regionFallbackOrder };
}

function getRegionOrder(flag: string, ctx: ProxySortContext): number {
  const customIndex = ctx.customOrder.indexOf(flag);
  if (customIndex >= 0) return customIndex;
  const fallback = ctx.regionFallbackOrder.get(flag);
  if (fallback !== undefined) return fallback;
  return ctx.customOrder.length + 9999;
}

export function compareProxySortKeys(
  nameA: string,
  indexA: number,
  nameB: string,
  indexB: number,
  ctx: ProxySortContext,
): number {
  const subA = ctx.subscriptionOrder.get(resolveSubscriptionGroup(nameA)) ?? 9999;
  const subB = ctx.subscriptionOrder.get(resolveSubscriptionGroup(nameB)) ?? 9999;
  if (subA !== subB) return subA - subB;

  const regionA = getRegionOrder(resolveRegionFlag(nameA), ctx);
  const regionB = getRegionOrder(resolveRegionFlag(nameB), ctx);
  if (regionA !== regionB) return regionA - regionB;

  const successA = getConnectivitySuccessCount(nameA);
  const successB = getConnectivitySuccessCount(nameB);
  if (successA !== successB) return successB - successA;

  return indexA - indexB;
}

/**
 * 订阅块顺序不变 → 同块内地区顺序不变 → 同地区内按成功次数降序 → 再保留原顺序
 */
export function sortProxiesByRegionAndConnectivity<T>(
  items: T[],
  customOrder: string[],
  getName: (item: T) => string,
): T[] {
  if (items.length <= 1) return items;

  const ctx = buildProxySortContext(items, customOrder, getName);
  const decorated = items.map((item, originalIndex) => ({ item, originalIndex }));

  decorated.sort((a, b) =>
    compareProxySortKeys(
      getName(a.item),
      a.originalIndex,
      getName(b.item),
      b.originalIndex,
      ctx,
    ),
  );

  return decorated.map((entry) => entry.item);
}

/** @deprecated 请使用 buildProxySortContext + compareProxySortKeys */
export function compareProxyNamesByRegionAndConnectivity(
  nameA: string,
  nameB: string,
  originalIndexA: number,
  originalIndexB: number,
  customOrder: string[],
  allNames?: string[],
): number {
  const names = allNames ?? [nameA, nameB];
  const ctx = buildProxySortContext(names, customOrder, (name) => name);
  return compareProxySortKeys(nameA, originalIndexA, nameB, originalIndexB, ctx);
}
