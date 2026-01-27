/**
 * Generate update.json and update-proxy.json for the autobuild release,
 * then upload them to that release. Uses GitHub API (no @actions/github).
 * Run in CI with: AUTOBUILD_VERSION=x.y.z node scripts/autobuild-update-json.mjs
 * or: node scripts/autobuild-update-json.mjs x.y.z
 */
const tag = "autobuild";
const token = process.env.GITHUB_TOKEN;
const version =
  process.env.AUTOBUILD_VERSION ||
  process.argv[2] ||
  process.argv[3]; /* via ${{ env.VERSION }} */

if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}
if (!version) {
  console.error("AUTOBUILD_VERSION or version argument is required");
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || "clash-verge-rev/clash-verge-rev";
const [owner, repoName] = repo.split("/");
const base = `https://api.github.com/repos/${owner}/${repoName}`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

function makePlatforms() {
  return {
    win64: { signature: "", url: "" },
    linux: { signature: "", url: "" },
    darwin: { signature: "", url: "" },
    "darwin-aarch64": { signature: "", url: "" },
    "darwin-intel": { signature: "", url: "" },
    "darwin-x86_64": { signature: "", url: "" },
    "linux-x86_64": { signature: "", url: "" },
    "linux-x86": { signature: "", url: "" },
    "linux-i686": { signature: "", url: "" },
    "linux-aarch64": { signature: "", url: "" },
    "linux-armv7": { signature: "", url: "" },
    "windows-x86_64": { signature: "", url: "" },
    "windows-aarch64": { signature: "", url: "" },
    "windows-x86": { signature: "", url: "" },
    "windows-i686": { signature: "", url: "" },
  };
}

function fillFromAsset(platforms, name, url) {
  const n = name.toLowerCase();
  if ((n.includes("x64-setup") || n.endsWith("x64-setup.exe")) && n.endsWith(".exe")) {
    platforms.win64.url = url;
    platforms["windows-x86_64"].url = url;
  }
  if ((n.includes("x86-setup") || n.endsWith("x86-setup.exe")) && n.endsWith(".exe")) {
    platforms["windows-x86"].url = url;
    platforms["windows-i686"].url = url;
  }
  if ((n.includes("arm64-setup") || n.endsWith("arm64-setup.exe")) && n.endsWith(".exe")) {
    platforms["windows-aarch64"].url = url;
  }
  if (n.endsWith(".app.tar.gz") && !n.includes("aarch")) {
    platforms.darwin.url = url;
    platforms["darwin-intel"].url = url;
    platforms["darwin-x86_64"].url = url;
  }
  if (n.endsWith("aarch64.app.tar.gz")) {
    platforms["darwin-aarch64"].url = url;
    platforms.linux.url = url;
    platforms["linux-x86_64"].url = url;
    platforms["linux-x86"].url = url;
    platforms["linux-i686"].url = url;
    platforms["linux-aarch64"].url = url;
    platforms["linux-armv7"].url = url;
  }
}

async function main() {
  const r = await fetch(`${base}/releases/tags/${tag}`, { headers });
  if (!r.ok) {
    console.error("Get release failed:", r.status, await r.text());
    process.exit(1);
  }
  const release = await r.json();
  const releaseId = release.id;

  const platforms = makePlatforms();
  for (const asset of release.assets || []) {
    if (asset.name === "update.json" || asset.name === "update-proxy.json") continue;
    fillFromAsset(platforms, asset.name, asset.browser_download_url);
  }

  Object.keys(platforms).forEach((key) => {
    if (!platforms[key].url) delete platforms[key];
  });

  const updateData = {
    version,
    name: version,
    notes: "AutoBuild release. See GitHub Actions for details.",
    pub_date: new Date().toISOString(),
    platforms,
  };

  for (const asset of release.assets || []) {
    if (asset.name !== "update.json" && asset.name !== "update-proxy.json") continue;
    const delRes = await fetch(`${base}/releases/assets/${asset.id}`, {
      method: "DELETE",
      headers,
    });
    if (!delRes.ok) console.warn("Delete asset", asset.name, "failed:", delRes.status);
  }

  const proxyData = JSON.parse(JSON.stringify(updateData));
  const proxyPrefix = "https://download.clashverge.dev/";
  Object.values(proxyData.platforms).forEach((p) => {
    if (p.url) p.url = proxyPrefix + p.url;
  });

  const upload = async (fileName, body) => {
    const res = await fetch(
      `https://uploads.github.com/repos/${owner}/${repoName}/releases/${releaseId}/assets?name=${fileName}`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
        },
        body,
      },
    );
    if (!res.ok) {
      console.error("Upload", fileName, "failed:", res.status, await res.text());
      process.exit(1);
    }
    console.log("Uploaded", fileName);
  };

  await upload("update.json", JSON.stringify(updateData, null, 2));
  await upload("update-proxy.json", JSON.stringify(proxyData, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
