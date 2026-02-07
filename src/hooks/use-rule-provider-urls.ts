import useSWR from "swr";

import { getRuntimeConfig } from "@/services/cmds";

const RULE_PROVIDER_URLS_KEY = "ruleProviderUrlsFromRuntime";

interface RuntimeRuleProviderData {
  urls: Record<string, string>;
  rulesetOrder: string[];
}

function extractUrls(rp: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(rp)) {
    if (cfg && typeof cfg === "object" && typeof (cfg as { url?: string }).url === "string") {
      out[name] = (cfg as { url: string }).url;
    }
  }
  return out;
}

/**
 * 从 rules 数组中解析 RULE-SET 名称的首次出现顺序（与配置中 rules 顺序一致）
 */
function extractRulesetOrderFromRules(config: Record<string, unknown>): string[] {
  const raw = config["rules"];
  if (raw == null) return [];
  const lines: string[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts[0] === "RULE-SET" && parts[1] && !seen.has(parts[1])) {
      seen.add(parts[1]);
      order.push(parts[1]);
    }
  }
  return order;
}

async function fetchRuntimeRuleProviderData(): Promise<RuntimeRuleProviderData> {
  const config = await getRuntimeConfig();
  const empty: RuntimeRuleProviderData = { urls: {}, rulesetOrder: [] };
  if (!config || typeof config !== "object") return empty;
  const c = config as unknown as Record<string, unknown>;
  const rp = c["rule-providers"];
  const urls =
    rp && typeof rp === "object"
      ? extractUrls(rp as Record<string, unknown>)
      : {};
  const rulesetOrder = extractRulesetOrderFromRules(c);
  return { urls, rulesetOrder };
}

/**
 * 从运行中配置（getRuntimeConfig）解析 rule-providers 的 url，
 * 用于「打开」按钮（核心 API 未返回 url 时使用）
 */
export function useRuleProviderUrls(): Record<string, string> {
  const { data } = useSWR<RuntimeRuleProviderData>(
    RULE_PROVIDER_URLS_KEY,
    fetchRuntimeRuleProviderData,
    { revalidateOnFocus: false },
  );
  return data?.urls ?? {};
}

/**
 * 从运行中配置的 rules 中解析 RULE-SET 首次出现顺序，用于规则集合列表排序
 */
export function useRulesetOrderFromRules(): string[] {
  const { data } = useSWR<RuntimeRuleProviderData>(
    RULE_PROVIDER_URLS_KEY,
    fetchRuntimeRuleProviderData,
    { revalidateOnFocus: false },
  );
  return data?.rulesetOrder ?? [];
}

/** 用于在打开规则集合弹窗时重新拉取运行中配置的 SWR key */
export const ruleProviderUrlsSwrKey = RULE_PROVIDER_URLS_KEY;
