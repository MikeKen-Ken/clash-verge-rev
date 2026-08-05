/**
 * 将 autobuild release 上的安装包重命名为短平台名，并删除 Mac 解压包（.app.tar.gz）。
 *
 * 目标文件名：
 *   ClashVerge-Windows-x64-setup.exe
 *   ClashVerge-macOS-arm64.dmg
 */
const tag = "autobuild";
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY || "clash-verge-rev/clash-verge-rev";

if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const [owner, repoName] = repo.split("/");
const base = `https://api.github.com/repos/${owner}/${repoName}`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

/** @type {Array<{ match: (name: string) => boolean; target: string | null }>} */
const rules = [
  {
    match: (name) =>
      name.toLowerCase().endsWith(".app.tar.gz") ||
      name.toLowerCase().endsWith(".app.tar.gz.sig"),
    target: null, // 删除：不需要解压安装包
  },
  {
    match: (name) =>
      /x64-setup\.exe$/i.test(name) &&
      name !== "ClashVerge-Windows-x64-setup.exe",
    target: "ClashVerge-Windows-x64-setup.exe",
  },
  {
    match: (name) =>
      /aarch64\.dmg$/i.test(name) && name !== "ClashVerge-macOS-arm64.dmg",
    target: "ClashVerge-macOS-arm64.dmg",
  },
];

async function api(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${init.method || "GET"} ${url} -> ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  const accept = init.headers?.Accept || "";
  if (String(accept).includes("application/octet-stream")) {
    return res.arrayBuffer();
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res.arrayBuffer();
}

async function deleteAsset(asset) {
  console.log("删除资源:", asset.name);
  await api(`${base}/releases/assets/${asset.id}`, { method: "DELETE" });
}

async function uploadAsset(releaseId, fileName, body) {
  console.log("上传资源:", fileName);
  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repoName}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;
  await api(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body,
  });
}

async function main() {
  const release = await api(`${base}/releases/tags/${tag}`);
  const releaseId = release.id;
  const assets = release.assets || [];

  for (const asset of assets) {
    const rule = rules.find((r) => r.match(asset.name));
    if (!rule) continue;

    if (rule.target === null) {
      await deleteAsset(asset);
      continue;
    }

    // 目标名已存在则先删旧的短名，再上传新文件
    const existing = assets.find((a) => a.name === rule.target);
    if (existing) {
      await deleteAsset(existing);
    }

    console.log(`重命名: ${asset.name} -> ${rule.target}`);
    const body = await api(`${base}/releases/assets/${asset.id}`, {
      headers: {
        Accept: "application/octet-stream",
      },
    });
    await uploadAsset(releaseId, rule.target, body);
    await deleteAsset(asset);
  }

  console.log("autobuild 资源重命名完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
