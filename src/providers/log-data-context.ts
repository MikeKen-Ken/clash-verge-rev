import { createContext, use } from "react";

import type { useLogData } from "@/hooks/use-log-data";

export type LogDataContextValue = ReturnType<typeof useLogData>;

export const LogDataContext = createContext<LogDataContextValue | null>(null);

export const useLogDataContext = () => {
  const context = use(LogDataContext);
  if (!context) {
    throw new Error("useLogDataContext must be used within LogDataProvider");
  }
  return context;
};
