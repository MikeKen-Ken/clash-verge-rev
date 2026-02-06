import useSWR from "swr";
import yaml from "js-yaml";

import { useProfiles } from "@/hooks/use-profiles";
import { readProfileFile } from "@/services/cmds";

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
 * 从当前 Profile（主配置 + merge + 全局 Merge）的 YAML 中解析 rule-providers 的 url，
 * 用于「打开」按钮（核心 API 未返回 url 时使用）
 */
export function useRuleProviderUrls(): Record<string, string> {
  const { current } = useProfiles();
  const uid = current?.uid ?? null;
  const mergeUid = current?.option?.merge ?? null;

  const { data } = useSWR<Record<string, string>>(
    uid ? ["ruleProviderUrls", uid, mergeUid] : null,
    async () => {
      if (!uid) {
        console.log("[ruleProviderUrls] 无 uid，跳过");
        return {};
      }
      const out: Record<string, string> = {};
      try {
        const mainStr = await readProfileFile(uid);
        const mainObj = yaml.load(mainStr) as { "rule-providers"?: Record<string, unknown> } | undefined;
        const mainRp = mainObj?.["rule-providers"] ?? {};
        const mainUrls = extractUrls(mainRp as Record<string, unknown>);
        Object.assign(out, mainUrls);
        console.log("[ruleProviderUrls] 主配置 uid:", uid, "rule-providers keys:", Object.keys(mainRp), "解析到 url 数量:", Object.keys(mainUrls).length, "样例:", Object.keys(mainUrls).slice(0, 3));
      } catch (e) {
        console.log("[ruleProviderUrls] 主配置读取失败:", e);
      }
      if (mergeUid) {
        try {
          const mergeStr = await readProfileFile(mergeUid);
          const mergeObj = yaml.load(mergeStr) as { "rule-providers"?: Record<string, unknown> } | undefined;
          const mergeUrls = extractUrls(mergeObj?.["rule-providers"] ?? {} as Record<string, unknown>);
          Object.assign(out, mergeUrls);
          console.log("[ruleProviderUrls] merge:", mergeUid, "解析到 url 数量:", Object.keys(mergeUrls).length);
        } catch (e) {
          console.log("[ruleProviderUrls] merge 读取失败:", e);
        }
      } else {
        console.log("[ruleProviderUrls] 无 mergeUid");
      }
      try {
        const globalStr = await readProfileFile("Merge");
        const globalObj = yaml.load(globalStr) as { "rule-providers"?: Record<string, unknown> } | undefined;
        const globalUrls = extractUrls(globalObj?.["rule-providers"] ?? {} as Record<string, unknown>);
        Object.assign(out, globalUrls);
        console.log("[ruleProviderUrls] Merge 解析到 url 数量:", Object.keys(globalUrls).length);
      } catch (e) {
        console.log("[ruleProviderUrls] Merge 读取失败(可忽略):", e);
      }
      console.log("[ruleProviderUrls] 最终 name->url 数量:", Object.keys(out).length, "names:", Object.keys(out).slice(0, 10));
      return out;
    },
    { revalidateOnFocus: false },
  );

  return data ?? {};
}
