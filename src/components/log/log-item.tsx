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
  "& .time, & .first-line-muted": {
    color: palette.text.secondary,
  },
  "& .type": {
    display: "inline-block",
    marginLeft: 0,
    marginRight: 8,
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
  "& .destination, & .rule-detail-value": {
    fontWeight: "bold",
    color: palette.primary.main,
  },
  "& .log-warning": {
    fontWeight: "bold",
    color: palette.warning.main,
  },
}));

interface Props {
  value: ILogItem;
  searchState?: SearchState;
}

const LogItem = ({ value, searchState }: Props) => {
  const theme = useTheme();
  const primaryColor = theme.palette.primary.main;
  const warningColor = theme.palette.warning.main;

  // 解析日志文本，标记目标地址、规则名、代理标签、以及 error / i/o timeout 等警告信息
  const parseLogText = (text: string): ReactNode[] => {
    // because ... failed ... active health check 整行用警告色
    if (/because.*failed|active\s+health\s+check/i.test(text)) {
      return [
        <span key="warning-line" className="log-warning">
          {text}
        </span>,
      ];
    }

    const elements: ReactNode[] = [];
    let lastIndex = 0;

    // 第二行格式：... --> host:port [--> ruleName] [match RuleSet(x)] --> proxy
    // 仅标记第一个目标地址（host:port）与警告词；规则名（如 proxy）不标记
    const destinationRegex = /\s-->\s+([^\s]+)(?=\s+(?:-->|match))/i;
    const destExec = destinationRegex.exec(text);
    const firstDest = destExec ? destExec[1] : null;
    const firstDestStart =
      destExec !== null
        ? destExec.index + destExec[0].indexOf(destExec[1])
        : -1;

    // 匹配 error: 至行尾、整词 error、i/o timeout，使用警告色加粗
    const errorToEolRegex = /\berror\s*:.*$/gim;
    const errorWordRegex = /\berror\b/gi;
    const timeoutRegex = /i\/o timeout/gi;
    let errToEolMatch: RegExpExecArray | null;
    let errWordMatch: RegExpExecArray | null;
    let timeoutMatch: RegExpExecArray | null;

    const matches: Array<{
      start: number;
      end: number;
      text: string;
      type: "destination" | "warning" | "rule-detail-value";
    }> = [];

    // 只标记第一个目标地址（host:port），不标记规则名（如 proxy）
    if (firstDestStart >= 0 && firstDest) {
      matches.push({
        start: firstDestStart,
        end: firstDestStart + firstDest.length,
        text: firstDest,
        type: "destination",
      });
    }

    // 规则详情段：高亮所有 (RuleType,value) 或 [RuleType,value] 中的 value，仅 value 部分（不含右侧的 ) 或 ]）
    const lastArrow = text.lastIndexOf(" --> ");
    let ruleDetailValueAdded = false;
    if (lastArrow > 0) {
      const secondLastArrow = text.lastIndexOf(" --> ", lastArrow - 1);
      if (secondLastArrow >= 0) {
        const ruleDetail = text.slice(secondLastArrow + 5, lastArrow);
        const baseOffset = secondLastArrow + 5;
        // 匹配 (xxx,value) 中的 value（value 到 ) 前结束）
        const parenRegex = /\([^,(]+,([^)]+)\)/g;
        // 匹配 [xxx,value] 中的 value（value 到 ] 前结束）
        const bracketRegex = /\[[^,\[]+,([^\]]+)\]/g;
        let m: RegExpExecArray | null;
        while ((m = parenRegex.exec(ruleDetail)) !== null) {
          const valueText = m[1];
          if (valueText.length > 0) {
            const valueStartInMatch = m[0].length - valueText.length - 1;
            matches.push({
              start: baseOffset + m.index + valueStartInMatch,
              end: baseOffset + m.index + valueStartInMatch + valueText.length,
              text: valueText,
              type: "rule-detail-value",
            });
            ruleDetailValueAdded = true;
          }
        }
        while ((m = bracketRegex.exec(ruleDetail)) !== null) {
          const valueText = m[1];
          if (valueText.length > 0) {
            const valueStartInMatch = m[0].length - valueText.length - 1;
            matches.push({
              start: baseOffset + m.index + valueStartInMatch,
              end: baseOffset + m.index + valueStartInMatch + valueText.length,
              text: valueText,
              type: "rule-detail-value",
            });
            ruleDetailValueAdded = true;
          }
        }
      }
    }
    // 若未从「最后一个 --> 前一段」解析到规则值，则整行匹配规则类型,值（如 DOMAIN-SUFFIX,+.cursor.sh），高亮值部分（值不含 ] )）
    if (!ruleDetailValueAdded) {
      const ruleValueRegex =
        /(DOMAIN-SUFFIX|GEOIP|IP-CIDR|IP-CIDR6|MATCH|RULE-SET|SUB-RULE|PROCESS-NAME|DST-PORT|SRC-PORT),([^\s\]\)-->]+)/gi;
      let ruleValueMatch: RegExpExecArray | null;
      while ((ruleValueMatch = ruleValueRegex.exec(text)) !== null) {
        const valueStart = ruleValueMatch.index + ruleValueMatch[1].length + 1;
        const valueEnd = valueStart + ruleValueMatch[2].length;
        const valueText = ruleValueMatch[2];
        if (valueText.length > 0) {
          matches.push({
            start: valueStart,
            end: valueEnd,
            text: valueText,
            type: "rule-detail-value",
          });
        }
      }
    }

    // 查找 error: 至行尾（优先）、整词 error、i/o timeout
    while ((errToEolMatch = errorToEolRegex.exec(text)) !== null) {
      matches.push({
        start: errToEolMatch.index,
        end: errToEolMatch.index + errToEolMatch[0].length,
        text: errToEolMatch[0],
        type: "warning",
      });
    }
    while ((errWordMatch = errorWordRegex.exec(text)) !== null) {
      // 若该 error 已包含在某个 error:... 段内则跳过，避免重复
      const contained = matches.some(
        (m) =>
          m.type === "warning" &&
          m.start <= errWordMatch!.index &&
          m.end >= errWordMatch!.index + errWordMatch![0].length,
      );
      if (!contained) {
        matches.push({
          start: errWordMatch.index,
          end: errWordMatch.index + errWordMatch[0].length,
          text: errWordMatch[0],
          type: "warning",
        });
      }
    }
    while ((timeoutMatch = timeoutRegex.exec(text)) !== null) {
      matches.push({
        start: timeoutMatch.index,
        end: timeoutMatch.index + timeoutMatch[0].length,
        text: timeoutMatch[0],
        type: "warning",
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
      const className =
        match.type === "destination"
          ? "destination"
          : match.type === "rule-detail-value"
            ? "rule-detail-value"
            : "log-warning";
      const color = match.type === "warning" ? warningColor : primaryColor;
      elements.push(
        <span
          key={`${match.type}-${match.start}`}
          className={className}
          style={{ color }}
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
    // 先解析目标地址和规则名
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

  // 从 payload 提取协议 [TCP]/[UDP]，并生成第二行：去掉协议、去掉进程名括号、match RuleSet(x) 改为 --> x
  const payloadLine = (() => {
    const raw = value.payload || "";
    const protocolMatch = raw.match(/^\[(TCP|UDP)\]\s*/i);
    const protocol = protocolMatch
      ? `[${protocolMatch[1].toUpperCase()}]`
      : null;
    const withoutProtocol = protocol
      ? raw.slice(protocolMatch![0].length)
      : raw;
    let secondLine = withoutProtocol;
    if (value.processName) {
      const esc = value.processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      secondLine = secondLine.replace(new RegExp(`\\(${esc}\\)`, "gi"), "");
    }
    // RULE-SET/RuleSet 带 ruleDetail：match RuleSet(name)[detail] 改为 --> name --> [detail]
    secondLine = secondLine.replace(
      /\s+match\s+(?:RULE-SET|RuleSet)\s*\(([^)]+)\)\s*\[([^\]]*)\]\s*/gi,
      " --> $1 --> [$2]",
    );
    // match RULE-SET(x)/RuleSet(x) 改为 --> x，但若前面已有 --> x 则只删 match，避免规则名重复
    secondLine = secondLine.replace(
      /\s+match\s+(?:RULE-SET|RuleSet)\s*\(([^)]+)\)/gi,
      (match, ruleName, offset) => {
        const name = ruleName.trim();
        const before = secondLine.slice(0, offset);
        const lastArrow = before.lastIndexOf(" --> ");
        const afterLast = before.slice(lastArrow + " --> ".length).trim();
        const token = afterLast.split(/\s+/)[0] ?? "";
        if (token === name) return ""; // 已有规则名，只删 match RuleSet(x)
        return " --> " + name;
      },
    );
    // match 其他规则类型(payload)[detail]：如 match DOMAIN-SUFFIX(+.cursor.sh) 改为 --> DOMAIN-SUFFIX,+.cursor.sh
    secondLine = secondLine.replace(
      /\s+match\s+(DOMAIN-SUFFIX|DOMAIN|DOMAIN-KEYWORD|GEOIP|IP-CIDR|IP-CIDR6|GEOSITE|PROCESS-NAME|DST-PORT|SRC-PORT|IN-TYPE|IN-PORT|MATCH)\s*\(([^)]*)\)\s*(?:\[([^\]]*)\])?\s*/gi,
      (_, ruleType, payload, detail) => {
        if (detail) {
          return ` --> ${ruleType},${payload} --> ${detail}`;
        }
        return ` --> ${ruleType},${payload}`;
      },
    );
    // applications using ⬆️[DIRECT] 改为 applications --> ⬆️[DIRECT]
    secondLine = secondLine.replace(/\s+using\s+/, " --> ");
    // dial ⬆️ (match RULE-SET/games-cn) 改为 dial ⬆️ --> games-cn -->
    secondLine = secondLine.replace(
      /\s*\(?\s*match\s+(?:RULE-SET|RuleSet)\s*[\/\s]\s*([^\s)]+)\s*\)?\s*/gi,
      " --> $1 --> ",
    );
    return { protocol, secondLine };
  })();

  return (
    <Item>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="type" data-type={value.type.toLowerCase()}>
          {renderHighlightText(value.type)}
        </span>
        {value.processName && (
          <>
            <LogProcessIcon processName={value.processName} size={16} />
            <span className="first-line-muted">{value.processName}</span>
          </>
        )}
        {payloadLine.protocol && (
          <span className="first-line-muted">{payloadLine.protocol}</span>
        )}
        <span className="time">{renderHighlightText(value.time || "")}</span>
      </div>
      <div>
        <span className="data">
          {renderHighlightText(payloadLine.secondLine)}
        </span>
      </div>
    </Item>
  );
};

export default LogItem;
