import { useCallback, useState } from "react";

const STORAGE_KEY = "proxies_hide_unavailable";

function readStoredValue(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function useHideUnavailableNodes() {
  const [hideUnavailableNodes, setHideUnavailableNodes] =
    useState(readStoredValue);

  const updateHideUnavailableNodes = useCallback((checked: boolean) => {
    setHideUnavailableNodes(checked);
    try {
      localStorage.setItem(STORAGE_KEY, String(checked));
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }, []);

  return {
    hideUnavailableNodes,
    setHideUnavailableNodes: updateHideUnavailableNodes,
  };
}
