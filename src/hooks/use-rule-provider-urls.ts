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
  const mergeUid = current?.merge ?? null;

  const { data } = useSWR<Record<string, string>>(
    uid ? ["ruleProviderUrls", uid, mergeUid] : null,
    async () => {
      if (!uid) return {};
      const out: Record<string, string> = {};
      try {
        const mainStr = await readProfileFile(uid);
        const mainObj = yaml.load(mainStr) as { "rule-providers"?: Record<string, unknown> } | undefined;
        Object.assign(out, extractUrls(mainObj?.["rule-providers"] ?? {}));
      } catch {
        // ignore
      }
      if (mergeUid) {
        try {
          const mergeStr = await readProfileFile(mergeUid);
          const mergeObj = yaml.load(mergeStr) as { "rule-providers"?: Record<string, unknown> } | undefined;
          Object.assign(out, extractUrls(mergeObj?.["rule-providers"] ?? {}));
        } catch {
          // ignore
        }
      }
      try {
        const globalStr = await readProfileFile("Merge");
        const globalObj = yaml.load(globalStr) as { "rule-providers"?: Record<string, unknown> } | undefined;
        Object.assign(out, extractUrls(globalObj?.["rule-providers"] ?? {}));
      } catch {
        // ignore
      }
      return out;
    },
    { revalidateOnFocus: false },
  );

  return data ?? {};
}
