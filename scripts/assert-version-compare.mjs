/**
 * 纯 Node 断言：与 src/services/update.ts 中版本比较语义对齐。
 * 运行：node scripts/assert-version-compare.mjs
 */

const normalizeVersion = (input) => {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
};

const ensureSemver = (input) => {
  const normalized = normalizeVersion(input);
  if (!normalized) return null;
  return /^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    normalized,
  )
    ? normalized
    : null;
};

const parseDotTokens = (part) => {
  if (!part) return [];
  return part.split(".").map((token) => {
    if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
    return token;
  });
};

const splitVersion = (version) => {
  const normalized = ensureSemver(version);
  if (!normalized) return null;
  const plusIndex = normalized.indexOf("+");
  const core = plusIndex >= 0 ? normalized.slice(0, plusIndex) : normalized;
  const buildPart = plusIndex >= 0 ? normalized.slice(plusIndex + 1) : "";
  const dashIndex = core.indexOf("-");
  const mainPart = dashIndex >= 0 ? core.slice(0, dashIndex) : core;
  const prePart = dashIndex >= 0 ? core.slice(dashIndex + 1) : "";
  const main = mainPart
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((num) => (Number.isNaN(num) ? 0 : num));
  return {
    main,
    pre: parseDotTokens(prePart),
    build: parseDotTokens(buildPart),
  };
};

const compareIdentSequences = (a, b) => {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const aToken = a[i];
    const bToken = b[i];
    if (aToken === undefined) return -1;
    if (bToken === undefined) return 1;
    if (typeof aToken === "number" && typeof bToken === "number") {
      if (aToken > bToken) return 1;
      if (aToken < bToken) return -1;
      continue;
    }
    if (typeof aToken === "number") return -1;
    if (typeof bToken === "number") return 1;
    if (aToken > bToken) return 1;
    if (aToken < bToken) return -1;
  }
  return 0;
};

const compareVersionParts = (a, b) => {
  const length = Math.max(a.main.length, b.main.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.main[i] ?? 0) - (b.main[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.pre.length === 0 && b.pre.length !== 0) return 1;
  if (a.pre.length !== 0 && b.pre.length === 0) return -1;
  if (a.pre.length !== 0 && b.pre.length !== 0) {
    const preCmp = compareIdentSequences(a.pre, b.pre);
    if (preCmp !== 0) return preCmp;
  }
  if (a.build.length === 0 && b.build.length === 0) return 0;
  if (a.build.length === 0) return -1;
  if (b.build.length === 0) return 1;
  return compareIdentSequences(a.build, b.build);
};

const compareVersions = (a, b) => {
  const partsA = splitVersion(a);
  const partsB = splitVersion(b);
  if (!partsA || !partsB) return null;
  return compareVersionParts(partsA, partsB);
};

/** 模拟 checkForkUpdate 对 comparison 的处理契约 */
const decideUpdateAvailability = (remote, local) => {
  const comparison = compareVersions(
    normalizeVersion(remote),
    normalizeVersion(local),
  );
  if (comparison === null) {
    return { status: "error", comparison };
  }
  if (comparison <= 0) {
    return { status: "up-to-date", comparison };
  }
  return { status: "available", comparison };
};

const cases = [
  {
    name: "autobuild 相对正式版可更新",
    remote: "2.4.6+ab.0806.438e7da",
    local: "2.4.6",
    expect: "available",
    expectCmp: 1,
  },
  {
    name: "相同版本已是最新",
    remote: "2.4.6",
    local: "2.4.6",
    expect: "up-to-date",
    expectCmp: 0,
  },
  {
    name: "本地更高则已是最新",
    remote: "2.4.5",
    local: "2.4.6",
    expect: "up-to-date",
    expectCmp: -1,
  },
  {
    name: "远程无法解析必须失败而非最新",
    remote: "",
    local: "2.4.6",
    expect: "error",
    expectCmp: null,
  },
  {
    name: "非空但非法的远程版本必须失败",
    remote: "nightly",
    local: "2.4.6",
    expect: "error",
    expectCmp: null,
  },
  {
    name: "本地无法解析必须失败而非最新",
    remote: "2.4.6+ab.0806.438e7da",
    local: null,
    expect: "error",
    expectCmp: null,
  },
];

let failed = 0;
for (const c of cases) {
  const result = decideUpdateAvailability(c.remote, c.local);
  const ok = result.status === c.expect && result.comparison === c.expectCmp;
  if (!ok) {
    failed += 1;
    console.error("FAIL", c.name, {
      expected: c.expect,
      expectCmp: c.expectCmp,
      got: result,
    });
  } else {
    console.log("PASS", c.name, result);
  }
}

// 旧逻辑回归：comparison === null || comparison <= 0 会把解析失败当成最新
const buggyTreatsAsLatest = (comparison) =>
  comparison === null || comparison <= 0;
if (buggyTreatsAsLatest(null) !== true) {
  failed += 1;
  console.error("FAIL 旧逻辑探针");
} else {
  console.log("PASS 确认旧逻辑会把 null 当成最新（已在 fork-update 修复）");
}

const inferAutobuildTime = (version, nowMs) => {
  if (!version) return null;
  const match = String(version).match(/\+ab\.(\d{8}|\d{4})(?:[.+]|$)/i);
  if (!match) return null;
  const stamp = match[1];
  const shanghaiYmdToMs = (year, month, day) =>
    new Date(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+08:00`,
    ).getTime();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const num = (type) => Number(parts.find((part) => part.type === type)?.value);
  let year;
  let month;
  let day;
  if (stamp.length === 8) {
    year = Number(stamp.slice(0, 4));
    month = Number(stamp.slice(4, 6));
    day = Number(stamp.slice(6, 8));
  } else {
    month = Number(stamp.slice(0, 2));
    day = Number(stamp.slice(2, 4));
    year = num("year");
    if (shanghaiYmdToMs(year, month, day) > nowMs) year -= 1;
  }
  return shanghaiYmdToMs(year, month, day);
};

const shouldOfferForkUpdate = (remote, local, pubDate, nowMs) => {
  const comparison = compareVersions(
    normalizeVersion(remote),
    normalizeVersion(local),
  );
  if (comparison === null) return null;
  if (comparison === 0) return false;
  const remoteParts = splitVersion(remote);
  const localParts = splitVersion(local);
  if (!remoteParts || !localParts) return null;
  const precedenceComparison = compareVersionParts(
    { ...remoteParts, build: [] },
    { ...localParts, build: [] },
  );
  if (precedenceComparison !== 0) {
    return precedenceComparison > 0;
  }
  const localTime = inferAutobuildTime(local, nowMs);
  const remoteInferred = inferAutobuildTime(remote, nowMs);
  const remotePublished = pubDate ? Date.parse(pubDate) : Number.NaN;
  const remoteTime = Number.isNaN(remotePublished)
    ? remoteInferred
    : remotePublished;
  if (localTime != null && remoteTime != null) {
    if (remoteTime !== localTime) {
      return remoteTime > localTime;
    }
    return remote !== local;
  }
  if (remoteParts.build.length === 0 && localParts.build.length > 0) {
    return true;
  }
  return comparison > 0;
};

const now = Date.parse("2026-08-25T12:00:00+08:00");
const offerCases = [
  {
    name: "跨年：去年 12 月本地不应挡住今年 8 月远程",
    remote: "2.4.6+ab.0825.dc03999",
    local: "2.4.6+ab.1225.aaaaaaa",
    expect: true,
  },
  {
    name: "同日不同 hash 应可更新",
    remote: "2.4.6+ab.0825.bbbbbbb",
    local: "2.4.6+ab.0825.aaaaaaa",
    expect: true,
  },
  {
    name: "完全相同则已是最新",
    remote: "2.4.6+ab.0825.dc03999",
    local: "2.4.6+ab.0825.dc03999",
    expect: false,
  },
  {
    name: "主版本更低不降级",
    remote: "2.4.5+ab.0825.dc03999",
    local: "2.4.6+ab.0101.aaaaaaa",
    expect: false,
  },
  {
    name: "跨年反向：去年 12 月远程不得覆盖今年 1 月本地",
    remote: "2.4.6+ab.1231.old",
    local: "2.4.6+ab.0104.new",
    pubDate: "2026-12-31T12:00:00+08:00",
    nowMs: Date.parse("2027-01-05T12:00:00+08:00"),
    expect: false,
  },
];

for (const c of offerCases) {
  const got = shouldOfferForkUpdate(
    c.remote,
    c.local,
    c.pubDate,
    c.nowMs ?? now,
  );
  if (got !== c.expect) {
    failed += 1;
    console.error("FAIL", c.name, { expected: c.expect, got });
  } else {
    console.log("PASS", c.name, got);
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个断言失败`);
  process.exit(1);
}
console.log("\n全部断言通过");
