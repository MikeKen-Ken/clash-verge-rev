import { getConnectivitySuccessCount } from "./proxy-connectivity-stats";

export const CUSTOM_PROXY_ORDER_STORAGE_KEY = "profiles.customProxyOrder";

export const DEFAULT_CUSTOM_PROXY_ORDER = [
  "🇭🇰",
  "🇯🇵",
  "🇸🇬",
  "🇹🇼",
  "🇺🇸",
] as const;

// 仅按节点名里的中文国家/地区关键字识别归属，避免英文缩写误命中（如 "in" 命中 "Origin"）。
// 顺序敏感（first-match）：当一个关键字是另一个的子串时，长的必须放前面，否则会被错判。
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

/** 仅根据节点名里的中文关键字识别归属；未命中返回 null */
export function resolveFlag(proxyName: string): string | null {
  for (const rule of COUNTRY_FLAG_KEYWORDS) {
    if (rule.keywords.some((keyword) => proxyName.includes(keyword))) {
      return rule.flag;
    }
  }
  return null;
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

function resolveGroupOrder(
  flag: string,
  customOrder: string[],
  fallbackOrderMap: Map<string, number>,
  nextFallbackOrderRef: { value: number },
): number {
  const orderMap = new Map(customOrder.map((item, index) => [item, index]));
  let groupOrder = orderMap.get(flag);
  if (groupOrder !== undefined) return groupOrder;

  const cached = fallbackOrderMap.get(flag);
  if (cached !== undefined) return cached;

  groupOrder = nextFallbackOrderRef.value;
  fallbackOrderMap.set(flag, groupOrder);
  nextFallbackOrderRef.value += 1;
  return groupOrder;
}

/** 地区顺序不变，同地区内按测速成功次数降序，再保留原顺序 */
export function sortProxiesByRegionAndConnectivity<T>(
  items: T[],
  customOrder: string[],
  getName: (item: T) => string,
): T[] {
  const fallbackOrderMap = new Map<string, number>();
  const nextFallbackOrderRef = { value: customOrder.length };

  const decorated = items.map((item, originalIndex) => {
    const name = getName(item);
    const flag = resolveFlag(name) ?? "";
    const groupOrder = resolveGroupOrder(
      flag,
      customOrder,
      fallbackOrderMap,
      nextFallbackOrderRef,
    );
    const successCount = getConnectivitySuccessCount(name);
    return { item, originalIndex, groupOrder, successCount };
  });

  decorated.sort((a, b) => {
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    return a.originalIndex - b.originalIndex;
  });

  return decorated.map((entry) => entry.item);
}

/** 比较两个节点名：先地区顺序，再成功次数，再原索引 */
export function compareProxyNamesByRegionAndConnectivity(
  nameA: string,
  nameB: string,
  originalIndexA: number,
  originalIndexB: number,
  customOrder: string[],
): number {
  const fallbackOrderMap = new Map<string, number>();
  const nextFallbackOrderRef = { value: customOrder.length };

  const flagA = resolveFlag(nameA) ?? "";
  const flagB = resolveFlag(nameB) ?? "";
  const groupA = resolveGroupOrder(
    flagA,
    customOrder,
    fallbackOrderMap,
    nextFallbackOrderRef,
  );
  const groupB = resolveGroupOrder(
    flagB,
    customOrder,
    fallbackOrderMap,
    nextFallbackOrderRef,
  );

  if (groupA !== groupB) return groupA - groupB;

  const successA = getConnectivitySuccessCount(nameA);
  const successB = getConnectivitySuccessCount(nameB);
  if (successA !== successB) return successB - successA;

  return originalIndexA - originalIndexB;
}
