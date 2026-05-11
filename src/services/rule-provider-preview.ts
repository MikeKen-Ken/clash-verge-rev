/** 规则集运行时展开预览（与核心 GET `/providers/rules/{name}` 一致）。 */
export interface IRuleProviderPreviewRule {
  ruleType: string;
  payload: string;
  policy: string;
}

export interface IRuleProviderPreview {
  name: string;
  behavior: string;
  policy: string;
  rules: IRuleProviderPreviewRule[];
}

export type RulesetPreviewFlatRow = {
  rulesetName: string;
  ruleType: string;
  payload: string;
  policy: string;
};
