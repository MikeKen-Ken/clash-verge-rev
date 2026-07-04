import parseTraffic from "@/utils/parse-traffic";

const BACKUP_FILENAME_PATTERN =
  /^(?<platform>[\w]+)-backup-(?<datetime>\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:-auto-(?<trigger>[\w]+))?\.zip$/i;

const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
  android: "Android",
  ios: "iOS",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  netbsd: "NetBSD",
  solaris: "Solaris",
  illumos: "Illumos",
  dragonfly: "DragonFly BSD",
  aix: "AIX",
};

const AUTO_TRIGGER_LABELS: Record<string, string> = {
  scheduled: "定时自动备份",
  merge: "全局扩展变更备份",
  script: "全局脚本变更备份",
  profile: "订阅变更备份",
};

const AUTO_TRIGGER_DESCRIPTIONS: Record<string, string> = {
  scheduled: "按设定频率在后台自动创建",
  merge: "全局扩展配置变更后自动创建",
  script: "全局脚本变更后自动创建",
  profile: "订阅增删改后自动创建",
};

export interface LocalBackupDisplayInfo {
  displayName: string;
  displayDescription: string;
}

const formatFileSize = (contentLength?: number) => {
  if (typeof contentLength !== "number" || contentLength <= 0) {
    return undefined;
  }
  const [value, unit] = parseTraffic(contentLength);
  return `${value} ${unit}`;
};

const getPlatformLabel = (platform?: string) => {
  if (!platform) return "未知平台";
  return PLATFORM_LABELS[platform.toLowerCase()] ?? platform;
};

export const getLocalBackupDisplayInfo = (
  filename: string,
  options?: {
    contentLength?: number;
    displayTime?: string;
  },
): LocalBackupDisplayInfo => {
  const match = filename.match(BACKUP_FILENAME_PATTERN);
  const fileSize = formatFileSize(options?.contentLength);
  const timeText = options?.displayTime?.trim();

  if (!match?.groups) {
    const stem = filename.replace(/\.zip$/i, "");
    const detailParts = [
      "导入或外部备份文件",
      timeText,
      fileSize,
    ].filter(Boolean);

    return {
      displayName: stem || filename,
      displayDescription: detailParts.join(" · "),
    };
  }

  const platform = getPlatformLabel(match.groups.platform);
  const trigger = match.groups.trigger?.toLowerCase();
  const displayName = trigger
    ? (AUTO_TRIGGER_LABELS[trigger] ?? "自动本地备份")
    : "手动本地备份";
  const triggerDescription = trigger
    ? (AUTO_TRIGGER_DESCRIPTIONS[trigger] ?? "关键变更后自动创建")
    : "通过「备份」按钮手动创建";

  const detailParts = [triggerDescription, platform, timeText, fileSize].filter(
    Boolean,
  );

  return {
    displayName,
    displayDescription: detailParts.join(" · "),
  };
};
