import { useEffect, useMemo, useReducer, useRef } from "react";

import delayManager, {
  DEFAULT_GROUP_TIMEOUT_MS,
} from "@/services/delay";
import {
  resolveRegionFlag,
  sortProxiesByConnectivity,
} from "@/services/proxy-region-sort";
import { compileStringMatcher } from "@/utils/search-matcher";

// default | delay | alphabet
export type ProxySortType = 0 | 1 | 2;

export type ProxySearchState = {
  matchCase?: boolean;
  matchWholeWord?: boolean;
  useRegularExpression?: boolean;
};

export default function useFilterSort(
  proxies: IProxyItem[],
  groupName: string,
  filterText: string,
  sortType: ProxySortType,
  searchState?: ProxySearchState,
  groupTimeout?: number,
  groupType?: string,
  regionFilter?: string,
) {
  const [_, bumpRefresh] = useReducer((count: number) => count + 1, 0);
  const lastInputRef = useRef<{ text: string; sort: ProxySortType } | null>(
    null,
  );
  const debounceTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let last = 0;

    delayManager.setGroupListener(groupName, () => {
      // 简单节流
      const now = Date.now();
      if (now - last > 666) {
        last = now;
        bumpRefresh();
      }
    });

    return () => {
      delayManager.removeGroupListener(groupName);
    };
  }, [groupName]);

  const compute = useMemo(() => {
    const fp = filterProxies(
      proxies,
      groupName,
      filterText,
      searchState,
      groupType,
      regionFilter,
    );
    const sp = sortProxies(
      fp,
      groupName,
      sortType,
      groupTimeout ?? DEFAULT_GROUP_TIMEOUT_MS,
      groupType,
    );
    return sp;
  }, [
    proxies,
    groupName,
    filterText,
    sortType,
    searchState,
    groupTimeout,
    groupType,
    regionFilter,
  ]);

  const [result, setResult] = useReducer(
    (_prev: IProxyItem[], next: IProxyItem[]) => next,
    compute,
  );

  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const prev = lastInputRef.current;
    const stableInputs =
      prev && prev.text === filterText && prev.sort === sortType;

    lastInputRef.current = { text: filterText, sort: sortType };

    const delay = stableInputs ? 0 : 150;
    debounceTimerRef.current = window.setTimeout(() => {
      setResult(compute);
      debounceTimerRef.current = null;
    }, delay);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [compute, filterText, sortType]);

  return result;
}

export function filterSort(
  proxies: IProxyItem[],
  groupName: string,
  filterText: string,
  sortType: ProxySortType,
  latencyTimeout?: number,
  searchState?: ProxySearchState,
  groupType?: string,
  regionFilter?: string,
) {
  const fp = filterProxies(
    proxies,
    groupName,
    filterText,
    searchState,
    groupType,
    regionFilter,
  );
  const sp = sortProxies(fp, groupName, sortType, latencyTimeout, groupType);
  return sp;
}

/**
 * 可以通过延迟数/节点类型 过滤
 */
const regex1 = /delay([=<>])(\d+|timeout|error)/i;
const regex2 = /type=(.*)/i;

/**
 * filter the proxy
 * according to the regular conditions
 */
function filterProxies(
  proxies: IProxyItem[],
  groupName: string,
  filterText: string,
  searchState?: ProxySearchState,
  groupType?: string,
  regionFilter?: string,
) {
  let list = proxies;

  if (
    regionFilter &&
    !isSelectorGroupType(groupType)
  ) {
    list = list.filter(
      (proxy) => resolveRegionFlag(proxy.name) === regionFilter,
    );
  }

  const query = filterText.trim();
  if (!query) return list;

  const res1 = regex1.exec(query);
  if (res1) {
    const symbol = res1[1];
    const symbol2 = res1[2].toLowerCase();
    const value =
      symbol2 === "error" ? 1e5 : symbol2 === "timeout" ? 3000 : +symbol2;

    const delayMap = delayManager.getDelaysForGroupFix(groupName, list);
    return list.filter((p) => {
      const delay = delayMap.get(p.name) ?? -1;

      if (delay < 0) return false;
      if (symbol === "=" && symbol2 === "error") return delay >= 1e5;
      if (symbol === "=" && symbol2 === "timeout")
        return delay < 1e5 && delay >= 3000;
      if (symbol === "=") return delay == value;
      if (symbol === "<") return delay <= value;
      if (symbol === ">") return delay >= value;
      return false;
    });
  }

  const res2 = regex2.exec(query);
  if (res2) {
    const type = res2[1].toLowerCase();
    return list.filter((p) => p.type.toLowerCase().includes(type));
  }

  const {
    matchCase = false,
    matchWholeWord = false,
    useRegularExpression = false,
  } = searchState ?? {};
  const compiled = compileStringMatcher(query, {
    matchCase,
    matchWholeWord,
    useRegularExpression,
  });

  if (!compiled.isValid) return [];
  return list.filter((p) => compiled.matcher(p.name));
}

/**
 * sort the proxy
 */
function isSelectorGroupType(groupType?: string): boolean {
  const t = (groupType ?? "").toLowerCase();
  return t === "select" || t === "selector";
}

function sortProxies(
  proxies: IProxyItem[],
  groupName: string,
  sortType: ProxySortType,
  latencyTimeout?: number,
  groupType?: string,
) {
  if (!proxies) return [];
  if (sortType === 0) {
    // Selector 组保持配置默认顺序，不按联通评分重排
    if (isSelectorGroupType(groupType)) {
      return proxies;
    }
    return sortProxiesByConnectivity(proxies, (proxy) => proxy.name);
  }

  const list = proxies.slice();
  const effectiveTimeout =
    typeof latencyTimeout === "number" && latencyTimeout > 0
      ? latencyTimeout
      : DEFAULT_GROUP_TIMEOUT_MS;

  if (sortType === 1) {
    const categorizeDelay = (delay: number): [number, number] => {
      if (!Number.isFinite(delay)) return [3, Number.MAX_SAFE_INTEGER];
      if (delay > 1e5) return [4, delay];
      if (delay === 0 || (delay >= effectiveTimeout && delay <= 1e5)) {
        return [3, delay || effectiveTimeout];
      }
      if (delay < 0) {
        // sentinel delays (-1, -2, etc.) should always sort after real measurements
        return [5, Number.MAX_SAFE_INTEGER];
      }
      return [0, delay];
    };

    const delayMap = delayManager.getDelaysForGroupFix(groupName, list);
    list.sort((a, b) => {
      const ad = delayMap.get(a.name) ?? -1;
      const bd = delayMap.get(b.name) ?? -1;
      const [ar, av] = categorizeDelay(ad);
      const [br, bv] = categorizeDelay(bd);

      if (ar !== br) return ar - br;
      return av - bv;
    });
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  return list;
}
