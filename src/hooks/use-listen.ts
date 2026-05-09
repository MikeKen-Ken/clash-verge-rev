import { event } from "@tauri-apps/api";
import { listen, UnlistenFn, EventCallback } from "@tauri-apps/api/event";
import { useCallback, useRef } from "react";

export const useListen = () => {
  const unlistenFnsRef = useRef<UnlistenFn[]>([]);

  const addListener = useCallback(
    async <T>(eventName: string, handler: EventCallback<T>) => {
      const unlisten = await listen(eventName, handler);

      // 包装一层：无论调用方是直接调用返回值还是走 removeAllListeners，
      // 都从 ref 数组中移除自身，避免长会话内反复挂载/卸载导致数组单向增长。
      let removed = false;
      const wrappedUnlisten: UnlistenFn = () => {
        if (removed) {
          return;
        }
        removed = true;
        const idx = unlistenFnsRef.current.indexOf(wrappedUnlisten);
        if (idx >= 0) {
          unlistenFnsRef.current.splice(idx, 1);
        }
        try {
          unlisten();
        } catch (error) {
          console.warn("[useListen] 调用 unlisten 失败", error);
        }
      };

      unlistenFnsRef.current.push(wrappedUnlisten);
      return wrappedUnlisten;
    },
    [],
  );

  const removeAllListeners = useCallback(() => {
    // 先快照并清空 ref，避免 wrappedUnlisten 在迭代中 splice 当前数组
    const pending = unlistenFnsRef.current.splice(
      0,
      unlistenFnsRef.current.length,
    );
    const errors: Error[] = [];

    pending.forEach((unlisten) => {
      try {
        unlisten();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (errors.length > 0) {
      console.warn(
        `[useListen] 清理监听器时发生 ${errors.length} 个错误`,
        errors,
      );
    }
  }, []);

  const setupCloseListener = useCallback(async () => {
    await event.once("tauri://close-requested", async () => {
      removeAllListeners();
    });
  }, [removeAllListeners]);

  return {
    addListener,
    removeAllListeners,
    setupCloseListener,
  };
};
