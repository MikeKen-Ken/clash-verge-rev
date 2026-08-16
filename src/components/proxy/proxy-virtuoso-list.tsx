import { useCallback, useEffect, useState, type CSSProperties, type RefObject } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { ProxyRender } from "./proxy-render";
import type { HeadState } from "./use-head-state";
import type { IRenderItem } from "./use-render-list";

const VirtuosoFooter = () => <div style={{ height: "8px" }} />;

const LIST_STYLE: CSSProperties = { height: "100%", width: "100%" };

interface Props {
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<Element | null>;
  renderList: IRenderItem[];
  indent: boolean;
  isChainMode?: boolean;
  initialScrollTop?: number;
  onScroll?: EventListener;
  onHeadState: (groupName: string, patch: Partial<HeadState>) => void;
  onChangeProxy: (
    group: IRenderItem["group"],
    proxy: IRenderItem["proxy"] & { name: string },
    options?: { isManualSelection?: boolean },
  ) => void;
  getSelectedForGroup?: (groupName: string) => string | undefined;
  getDisplayNowForGroup?: (
    group: { name: string; now?: string | null },
    useNameAsLabel?: boolean,
  ) => string;
  getManualSelectionForGroup?: (groupName: string) => string | undefined;
}

/**
 * 视口必须有确定高度，否则 Virtuoso 会按内容撑开并把整组节点全部挂载。
 */
export const ProxyVirtuosoList = (props: Props) => {
  const {
    virtuosoRef,
    scrollerRef,
    renderList,
    indent,
    isChainMode,
    initialScrollTop,
    onScroll,
    onHeadState,
    onChangeProxy,
    getSelectedForGroup,
    getDisplayNowForGroup,
    getManualSelectionForGroup,
  } = props;

  const [scroller, setScroller] = useState<Element | null>(null);

  useEffect(() => {
    scrollerRef.current = scroller;
    if (!scroller || !onScroll) return;
    const options: AddEventListenerOptions = { passive: true };
    scroller.addEventListener("scroll", onScroll, options);
    return () => {
      scroller.removeEventListener("scroll", onScroll, options);
    };
  }, [scroller, onScroll, scrollerRef]);

  const itemContent = useCallback(
    (_index: number, item: IRenderItem) => (
      <ProxyRender
        item={item}
        indent={indent}
        isChainMode={isChainMode}
        onHeadState={onHeadState}
        onChangeProxy={onChangeProxy}
        getSelectedForGroup={getSelectedForGroup}
        getDisplayNowForGroup={getDisplayNowForGroup}
        getManualSelectionForGroup={getManualSelectionForGroup}
      />
    ),
    [
      indent,
      isChainMode,
      onHeadState,
      onChangeProxy,
      getSelectedForGroup,
      getDisplayNowForGroup,
      getManualSelectionForGroup,
    ],
  );

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={renderList}
      style={LIST_STYLE}
      increaseViewportBy={80}
      overscan={80}
      defaultItemHeight={56}
      scrollerRef={(ref) => {
        setScroller((ref as Element) ?? null);
      }}
      components={{ Footer: VirtuosoFooter }}
      initialScrollTop={initialScrollTop}
      computeItemKey={(_index, item) => item.key}
      itemContent={itemContent}
    />
  );
};
