import {
  buildConnectivityScoreContext,
  type ConnectivityScoreContext,
} from "./proxy-connectivity-stats";

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

/** 优先匹配节点名前缀的地区 emoji（如 🇭🇰 ✅ 01），再回退中文关键字 */
export function resolveRegionFlag(proxyName: string): string {
  const trimmed = proxyName.trim();
  for (const flag of ALL_REGION_FLAGS) {
    if (trimmed.startsWith(flag)) return flag;
  }
  return resolveFlag(trimmed) ?? "";
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

/** 全局按贝叶斯平滑成功率降序，相同时保留原顺序 */
export function sortProxiesByConnectivity<T>(
  items: T[],
  getName: (item: T) => string,
  scoreContext?: ConnectivityScoreContext,
): T[] {
  if (items.length <= 1) return items;

  const context = scoreContext ?? buildConnectivityScoreContext();
  const decorated = items.map((item, originalIndex) => ({
    item,
    originalIndex,
    score: context.scoreFor(getName(item)),
  }));

  decorated.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  return decorated.map((entry) => entry.item);
}

/** 比较两个节点名：先贝叶斯成功率，再原索引 */
export function compareProxyNamesByConnectivity(
  nameA: string,
  nameB: string,
  originalIndexA: number,
  originalIndexB: number,
  scoreContext?: ConnectivityScoreContext,
): number {
  const context = scoreContext ?? buildConnectivityScoreContext();
  const scoreA = context.scoreFor(nameA);
  const scoreB = context.scoreFor(nameB);
  if (scoreA !== scoreB) return scoreB - scoreA;
  return originalIndexA - originalIndexB;
}

/** @deprecated 请改用 sortProxiesByConnectivity */
export function sortProxiesByRegionAndConnectivity<T>(
  items: T[],
  _customOrder: string[],
  getName: (item: T) => string,
): T[] {
  return sortProxiesByConnectivity(items, getName);
}

/** @deprecated 请改用 compareProxyNamesByConnectivity */
export function compareProxyNamesByRegionAndConnectivity(
  nameA: string,
  nameB: string,
  originalIndexA: number,
  originalIndexB: number,
  _customOrder: string[],
): number {
  return compareProxyNamesByConnectivity(
    nameA,
    nameB,
    originalIndexA,
    originalIndexB,
  );
}
