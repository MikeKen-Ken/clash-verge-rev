import { fetch } from "@tauri-apps/plugin-http";

import { debugLog } from "@/utils/debug";

interface IpInfo {
  ip: string;
  country_code: string;
  country: string;
  region: string;
  city: string;
  organization: string;
  asn: number;
  asn_organization: string;
  longitude: number;
  latitude: number;
  timezone: string;
}

interface ServiceConfig {
  url: string;
  timeoutSecs?: number;
  /** 将响应体解析为 IpInfo；解析失败应 throw */
  parse: (body: string) => IpInfo;
}

const EMPTY_GEO = {
  country_code: "",
  country: "",
  region: "",
  city: "",
  organization: "",
  asn: 0,
  asn_organization: "",
  longitude: 0,
  latitude: 0,
  timezone: "",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 解析 Cloudflare cdn-cgi/trace 纯文本响应 */
const parseCloudflareTrace = (body: string): IpInfo => {
  const ip =
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("ip="))
      ?.slice(3)
      .trim() ?? "";
  if (!ip) throw new Error("Cloudflare trace 响应无 ip 字段");
  return { ip, ...EMPTY_GEO };
};

const parseJsonBody = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("响应非 JSON");
  }
};

/** 解析 ipip.net 纯文本响应 */
const parseIpipNet = (body: string): IpInfo => {
  const match =
    body.match(/当前\s*IP[：:]\s*([\d.]+)/i) ??
    body.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  const ip = match?.[1]?.trim() ?? "";
  if (!ip) throw new Error("ipip.net 响应无 ip");
  return { ip, ...EMPTY_GEO };
};

/** 解析纯文本 IP 响应 */
const parsePlainIp = (body: string): IpInfo => {
  const ip = body.trim().split(/\s+/)[0] ?? "";
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new Error("纯文本响应无有效 ip");
  }
  return { ip, ...EMPTY_GEO };
};

// 与常见「查 IP」网站相同：直接请求第三方接口，由系统/TUN/系统代理决定出站
const IP_CHECK_SERVICES: ServiceConfig[] = [
  {
    url: "https://myip.ipip.net",
    timeoutSecs: 4,
    parse: parseIpipNet,
  },
  {
    url: "https://api-ipv4.ip.sb/ip",
    timeoutSecs: 4,
    parse: parsePlainIp,
  },
  {
    url: "https://api.ipify.org?format=json",
    timeoutSecs: 5,
    parse: (body) => {
      const data = parseJsonBody(body) as { ip?: string };
      if (!data?.ip) throw new Error("ipify 响应无 ip");
      return { ip: data.ip, ...EMPTY_GEO };
    },
  },
  {
    url: "https://1.1.1.1/cdn-cgi/trace",
    timeoutSecs: 5,
    parse: parseCloudflareTrace,
  },
  {
    url: "https://api.ip.sb/geoip",
    timeoutSecs: 6,
    parse: (body) => {
      const data = parseJsonBody(body) as Record<string, unknown>;
      if (!data?.ip) throw new Error("ip.sb 响应无 ip");
      return {
        ip: String(data.ip),
        country_code: String(data.country_code ?? ""),
        country: String(data.country ?? ""),
        region: String(data.region ?? ""),
        city: String(data.city ?? ""),
        organization: String(data.organization ?? data.isp ?? ""),
        asn: Number(data.asn) || 0,
        asn_organization: String(data.asn_organization ?? ""),
        longitude: Number(data.longitude) || 0,
        latitude: Number(data.latitude) || 0,
        timezone: String(data.timezone ?? ""),
      };
    },
  },
];

const OVERALL_TIMEOUT_MS = 15000;

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

/** 网站式查 IP：直接 HTTP 请求，出站由当前网络环境（TUN / 系统代理 / 直连）决定 */
const fetchIpServiceBody = async (
  url: string,
  timeoutMs: number,
): Promise<string> => {
  const response = await fetch(url, {
    method: "GET",
    connectTimeout: timeoutMs,
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
};

const tryService = async (service: ServiceConfig): Promise<IpInfo> => {
  const timeoutMs = (service.timeoutSecs ?? 5) * 1000;
  debugLog(`尝试IP检测服务: ${service.url}`);

  const body = await withTimeout(
    fetchIpServiceBody(service.url, timeoutMs),
    timeoutMs + 500,
    `请求超时 (${service.url})`,
  );

  const result = service.parse(body);
  if (!result.ip) throw new Error(`无效 IP (${service.url})`);

  debugLog(`IP检测成功，使用服务: ${service.url}`);
  return result;
};

/** 并行竞速，任一成功即返回；全部失败则抛出最后一个错误 */
export const getIpInfo = async (): Promise<IpInfo> => {
  const errors: Error[] = [];

  const tasks = IP_CHECK_SERVICES.map((service) =>
    tryService(service).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      errors.push(err);
      console.warn(`IP检测失败 (${service.url}):`, err.message);
      throw err;
    }),
  );

  try {
    return await withTimeout(
      Promise.any(tasks),
      OVERALL_TIMEOUT_MS,
      "出口 IP 检测超时，请确认网络可用",
    );
  } catch (aggregateError) {
    if (errors.length > 0) {
      throw new Error(
        `所有IP检测服务都失败: ${errors[errors.length - 1]?.message ?? "未知错误"}`,
      );
    }
    throw aggregateError instanceof Error
      ? aggregateError
      : new Error("没有可用的IP检测服务");
  }
};
