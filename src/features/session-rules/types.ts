export interface SessionRuleCandidate {
  ruleType: string;
  payload: string;
  label: string;
  category: string;
}

export interface AddSessionRuleInput {
  ruleType: string;
  payload: string;
  target: string;
  label: string;
}
