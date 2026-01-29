import { styled, Box, useTheme } from "@mui/material";
import type { ReactNode } from "react";

import type { SearchState } from "@/components/base";
import { LogProcessIcon } from "./log-process-icon";

const Item = styled(Box)(({ theme: { palette, typography } }) => ({
  padding: "8px 0",
  margin: "0 12px",
  lineHeight: 1.35,
  borderBottom: `1px solid ${palette.divider}`,
  fontSize: "0.875rem",
  fontFamily: typography.fontFamily,
  userSelect: "text",
  "& .time": {
    color: palette.text.secondary,
  },
  "& .type": {
    display: "inline-block",
    marginLeft: 8,
    textAlign: "center",
    borderRadius: 2,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  '& .type[data-type="error"], & .type[data-type="err"]': {
    color: palette.error.main,
  },
  '& .type[data-type="warning"], & .type[data-type="warn"]': {
    color: palette.warning.main,
  },
  '& .type[data-type="info"], & .type[data-type="inf"]': {
    color: palette.info.main,
  },
  "& .data": {
    color: palette.text.primary,
    overflowWrap: "anywhere",
  },
  "& .highlight": {
    backgroundColor: palette.mode === "dark" ? "#ffeb3b40" : "#ffeb3b90",
    borderRadius: 2,
    padding: "0 2px",
  },
  "& .process-name, & .rule-name": {
    fontWeight: "bold",
  },
}));

interface Props {
  value: ILogItem;
  searchState?: SearchState;
}

const LogItem = ({ value, searchState }: Props) => {
  const theme = useTheme();
  const primaryColor = theme.palette.primary.main;

  // 解析日志文本，标记程序名和规则
  const parseLogText = (text: string): ReactNode[] => {
    const elements: ReactNode[] = [];
    let lastIndex = 0;

    // 匹配程序名：括号中的内容，例如 (Chill With You.exe)
    // 匹配格式: (程序名.exe)
    const processNameRegex = /\(([^)]+\.exe)\)/gi;
    let processMatch: RegExpExecArray | null;

    // 匹配规则名称：RuleSet(规则名) 中的规则名
    // 匹配格式: RuleSet(规则名) 或 RULE-SET(规则名) 等，提取括号内的规则名
    const ruleRegex = /(?:RuleSet|RULE-SET|rule-set)\s*\(([^)]+)\)/gi;
    let ruleMatch: RegExpExecArray | null;

    // 收集所有匹配项及其位置
    const matches: Array<{
      start: number;
      end: number;
      text: string;
      type: "process" | "rule";
    }> = [];

    // 查找程序名
    while ((processMatch = processNameRegex.exec(text)) !== null) {
      matches.push({
        start: processMatch.index,
        end: processMatch.index + processMatch[0].length,
        text: processMatch[0],
        type: "process",
      });
    }

    // 查找规则名称
    while ((ruleMatch = ruleRegex.exec(text)) !== null) {
      // ruleMatch[1] 是括号内的规则名，需要找到它在原文本中的位置
      const fullMatch = ruleMatch[0]; // 例如 "RuleSet(custome-noHK)"
      const ruleName = ruleMatch[1]; // 例如 "custome-noHK"
      // 计算规则名在原文本中的位置：RuleSet( 之后的位置
      const leftParenIndex = fullMatch.indexOf("(");
      const ruleStart = ruleMatch.index + leftParenIndex + 1;
      matches.push({
        start: ruleStart,
        end: ruleStart + ruleName.length,
        text: ruleName,
        type: "rule",
      });
    }

    // 按位置排序
    matches.sort((a, b) => a.start - b.start);

    // 构建元素数组
    for (const match of matches) {
      // 添加匹配前的文本
      if (match.start > lastIndex) {
        elements.push(text.slice(lastIndex, match.start));
      }

      // 添加标记的匹配文本
      const className = match.type === "process" ? "process-name" : "rule-name";
      elements.push(
        <span
          key={`${match.type}-${match.start}`}
          className={className}
          style={{ color: primaryColor }}
        >
          {match.text}
        </span>,
      );

      lastIndex = match.end;
    }

    // 添加剩余的文本
    if (lastIndex < text.length) {
      elements.push(text.slice(lastIndex));
    }

    return elements.length > 0 ? elements : [text];
  };

  const renderHighlightText = (text: string) => {
    // 先解析程序名和规则
    const parsedElements = parseLogText(text);

    // 如果没有搜索条件，直接返回解析后的元素
    if (!searchState?.text.trim()) {
      return parsedElements;
    }

    // 如果有搜索条件，需要对每个文本节点进行高亮处理
    try {
      const searchText = searchState.text;
      let pattern: string;

      if (searchState.useRegularExpression) {
        try {
          new RegExp(searchText);
          pattern = searchText;
        } catch {
          pattern = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
      } else {
        const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pattern = searchState.matchWholeWord ? `\\b${escaped}\\b` : escaped;
      }

      const flags = searchState.matchCase ? "g" : "gi";
      const regex = new RegExp(pattern, flags);
      const result: ReactNode[] = [];

      // 对每个解析后的元素进行处理
      for (const element of parsedElements) {
        if (typeof element === "string") {
          // 对纯文本进行搜索高亮
          const textElements: ReactNode[] = [];
          let lastIndex = 0;
          let match: RegExpExecArray | null;

          while ((match = regex.exec(element)) !== null) {
            const start = match.index;
            const matchText = match[0];

            if (matchText === "") {
              regex.lastIndex += 1;
              continue;
            }

            if (start > lastIndex) {
              textElements.push(element.slice(lastIndex, start));
            }

            textElements.push(
              <span key={`highlight-${start}`} className="highlight">
                {matchText}
              </span>,
            );

            lastIndex = start + matchText.length;
          }

          if (lastIndex < element.length) {
            textElements.push(element.slice(lastIndex));
          }

          result.push(...(textElements.length ? textElements : [element]));
        } else {
          // 保留已标记的元素（程序名和规则）
          result.push(element);
        }
      }

      return result.length ? result : parsedElements;
    } catch {
      return parsedElements;
    }
  };

  return (
    <Item>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {value.processName && (
          <LogProcessIcon processName={value.processName} size={16} />
        )}
        <span className="time">{renderHighlightText(value.time || "")}</span>
        <span className="type" data-type={value.type.toLowerCase()}>
          {renderHighlightText(value.type)}
        </span>
      </div>
      <div>
        <span className="data">{renderHighlightText(value.payload)}</span>
      </div>
    </Item>
  );
};

export default LogItem;
