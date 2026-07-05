import { invoke } from "@tauri-apps/api/core";

import type { AddSessionRuleInput } from "./types";

export async function getSessionRules() {
  return invoke<ISessionRule[]>("get_session_rules");
}

export async function addSessionRule(input: AddSessionRuleInput) {
  return invoke<ISessionRule>("add_session_rule", {
    ruleType: input.ruleType,
    payload: input.payload,
    target: input.target,
    label: input.label,
  });
}

export async function removeSessionRule(id: string) {
  return invoke<void>("remove_session_rule", { id });
}

export async function clearSessionRules() {
  return invoke<void>("clear_session_rules");
}
