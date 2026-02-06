import useSWR from "swr";

import { getRuntimeConfig } from "@/services/cmds";

const RULE_PROVIDER_URLS_KEY = "ruleProviderUrlsFromRuntime";

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
 * 从运行中配置（getRuntimeConfig）解析 rule-providers 的 url，
 * 用于「打开」按钮（核心 API 未返回 url 时使用）
 */
export function useRuleProviderUrls(): Record<string, string> {
  const { data } = useSWR<Record<string, string>>(
    RULE_PROVIDER_URLS_KEY,
    async () => {
      const config = await getRuntimeConfig();
      if (!config || typeof config !== "object") return {};
      const rp = (config as Record<string, unknown>)["rule-providers"];
      if (!rp || typeof rp !== "object") return {};
      return extractUrls(rp as Record<string, unknown>);
    },
    { revalidateOnFocus: false },
  );

  return data ?? {};
}

/** 用于在打开规则集合弹窗时重新拉取运行中配置的 SWR key */
export const ruleProviderUrlsSwrKey = RULE_PROVIDER_URLS_KEY;
