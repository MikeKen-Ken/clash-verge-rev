import { convertFileSrc } from "@tauri-apps/api/core";
import { useMemo } from "react";
import useSWR from "swr";

import { extractProcessIcon } from "@/services/cmds";
import { SWR_DEFAULTS } from "@/services/config";

/**
 * Hook to get process icon from processPath
 * Extracts icon from executable file using Tauri command
 */
export const useProcessIcon = (processPath?: string) => {
  const swrKey = useMemo(() => {
    if (!processPath || processPath.trim() === "") {
      return null;
    }

    return ["process-icon", processPath] as const;
  }, [processPath]);

  const { data } = useSWR(
    swrKey,
    async () => {
      try {
        const iconPath = await extractProcessIcon(processPath);
        if (!iconPath || iconPath.trim() === "") {
          return "";
        }
        return convertFileSrc(iconPath);
      } catch (error) {
        console.warn("Failed to extract process icon:", error);
        return "";
      }
    },
    {
      ...SWR_DEFAULTS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );

  if (!swrKey) {
    return "";
  }

  return data ?? "";
};
