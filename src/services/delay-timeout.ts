import { delayProxyByName, type ProxyDelay } from "tauri-plugin-mihomo-api";

/**
 * 与核心测速赛跑，超时后返回 delay=0。
 * 无论谁先完成都会清掉定时器，避免批量测速留下大量未取消的 timeout。
 */
export async function raceProxyDelayWithTimeout(
  name: string,
  url: string,
  timeout: number,
): Promise<ProxyDelay> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<ProxyDelay>((resolve) => {
      timeoutId = setTimeout(() => resolve({ delay: 0 }), timeout);
    });
    return await Promise.race([
      delayProxyByName(name, url, timeout),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}
