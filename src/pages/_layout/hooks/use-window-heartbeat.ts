import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

const HEARTBEAT_GAP_MS = 5_000;

/**
 * Posts from requestAnimationFrame. A WebView that has stopped painting
 * (sleep, or a long-run compositor hang) stops calling this, and the shell
 * rebuilds the window.
 */
export function useWindowHeartbeat() {
  useEffect(() => {
    let stopped = false;
    let lastSent = 0;
    let frame = 0;

    const send = (now: number) => {
      if (stopped || now - lastSent < HEARTBEAT_GAP_MS) return;
      lastSent = now;
      void invoke("window_heartbeat").catch(() => {});
    };

    const loop = (now: number) => {
      if (stopped) return;
      send(now);
      frame = window.requestAnimationFrame(loop);
    };

    send(performance.now());
    frame = window.requestAnimationFrame(loop);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        lastSent = 0;
        send(performance.now());
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
