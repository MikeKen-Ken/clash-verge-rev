export const normalizeBlockedLanSourceIps = (ips: string[]): string[] =>
  Array.from(
    new Set(
      ips
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0),
    ),
  );

export const addBlockedLanSourceIp = (ips: string[], ip: string): string[] =>
  normalizeBlockedLanSourceIps([...ips, ip]);
