import { fetchWithLocalProxy } from "@/services/cmds";
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

// 按可靠性排序；并行请求时优先命中快且稳定的服务
const IP_CHECK_SERVICES: ServiceConfig[] = [
  {
    url: "https://1.1.1.1/cdn-cgi/trace",
    timeoutSecs: 5,
    parse: parseCloudflareTrace,
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
  {
    url: "https://ipwho.is/",
    timeoutSecs: 6,
    parse: (body) => {
      const data = parseJsonBody(body) as {
        success?: boolean;
        ip?: string;
        country_code?: string;
        country?: string;
        region?: string;
        city?: string;
        connection?: { org?: string; isp?: string; asn?: number };
        timezone?: { id?: string };
        longitude?: number;
        latitude?: number;
      };
      if (data?.success === false || !data?.ip) {
        throw new Error("ipwho.is 检测失败");
      }
      return {
        ip: data.ip,
        country_code: data.country_code || "",
        country: data.country || "",
        region: data.region || "",
        city: data.city || "",
        organization: data.connection?.org || data.connection?.isp || "",
        asn: data.connection?.asn || 0,
        asn_organization: data.connection?.isp || "",
        longitude: data.longitude || 0,
        latitude: data.latitude || 0,
        timezone: data.timezone?.id || "",
      };
    },
  },
  {
    url: "https://api.ipapi.is/",
    timeoutSecs: 6,
    parse: (body) => {
      const data = parseJsonBody(body) as {
        ip?: string;
        location?: {
          country_code?: string;
          country?: string;
          state?: string;
          city?: string;
          longitude?: number;
          latitude?: number;
          timezone?: string;
        };
        asn?: { org?: string; asn?: number };
        company?: { name?: string };
      };
      if (!data?.ip) throw new Error("ipapi.is 响应无 ip");
      return {
        ip: data.ip,
        country_code: data.location?.country_code || "",
        country: data.location?.country || "",
        region: data.location?.state || "",
        city: data.location?.city || "",
        organization: data.asn?.org || data.company?.name || "",
        asn: data.asn?.asn || 0,
        asn_organization: data.asn?.org || "",
        longitude: data.location?.longitude || 0,
        latitude: data.location?.latitude || 0,
        timezone: data.location?.timezone || "",
      };
    },
  },
];

const OVERALL_TIMEOUT_MS = 15000;
const INVOKE_GRACE_MS = 2000;

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

const tryService = async (service: ServiceConfig): Promise<IpInfo> => {
  const timeoutSecs = service.timeoutSecs ?? 5;
  debugLog(`尝试IP检测服务: ${service.url}`);

  const body = await withTimeout(
    fetchWithLocalProxy(service.url, timeoutSecs),
    timeoutSecs * 1000 + INVOKE_GRACE_MS,
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
      "出口 IP 检测超时，请确认核心已启动且网络可用",
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
