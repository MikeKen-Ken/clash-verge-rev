import useSWR, { mutate } from "swr";

import { getSessionRules } from "./api";

const SESSION_RULES_KEY = "getSessionRules";

export function useSessionRules() {
  return useSWR(SESSION_RULES_KEY, getSessionRules, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

export function refreshSessionRules() {
  return mutate(SESSION_RULES_KEY);
}
