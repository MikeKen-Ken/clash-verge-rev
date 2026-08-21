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
  scheduled: "Scheduled automatic backup",
  merge: "Global enhancement change backup",
  script: "Global script change backup",
  profile: "Subscription change backup",
};

const AUTO_TRIGGER_DESCRIPTIONS: Record<string, string> = {
  scheduled: "Created automatically in the background at the configured interval",
  merge: "Created automatically after global enhancement configuration changes",
  script: "Created automatically after global script changes",
  profile: "Created automatically after subscriptions are added, removed, or changed",
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
  if (!platform) return "Unknown platform";
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
      "Imported or external backup file",
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
    ? (AUTO_TRIGGER_LABELS[trigger] ?? "Automatic local backup")
    : "Manual local backup";
  const triggerDescription = trigger
    ? (AUTO_TRIGGER_DESCRIPTIONS[trigger] ?? "Created automatically after important changes")
    : "Created manually with the Backup button";

  const detailParts = [triggerDescription, platform, timeText, fileSize].filter(
    Boolean,
  );

  return {
    displayName,
    displayDescription: detailParts.join(" · "),
  };
};
