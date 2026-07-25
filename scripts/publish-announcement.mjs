import { spawnSync } from "node:child_process";

const repository = "xy2446522127-code/storyboard-copilot";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const title = value("--title");
const body = value("--body");
const level = value("--level") || "info";
const url = value("--url");
const expiresAt = value("--expires-at");

if (!title || !body || !["info", "success", "warning", "error"].includes(level)) {
  console.error("Usage: node scripts/publish-announcement.mjs --title <title> --body <body> [--level info|success|warning|error] [--url https://...] [--expires-at 2026-12-31T00:00:00Z]");
  process.exit(2);
}
const runGh = (argumentsList, input) => {
  const result = spawnSync("gh", argumentsList, { encoding: "utf8", input });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || "GitHub CLI failed");
  return result.stdout;
};

try {
  runGh(["auth", "status"]);
  const response = JSON.parse(runGh(["api", `repos/${repository}/contents/announcements.json`, "--method", "GET"]));
  const feed = JSON.parse(Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8"));
  const stamp = new Date().toISOString();
  const id = `${stamp.slice(0, 10)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "notice"}`;
  const announcement = { id, title, body, level, publishedAt: stamp };
  if (url) announcement.url = url;
  if (expiresAt) announcement.expiresAt = expiresAt;
  const announcements = Array.isArray(feed.announcements) ? feed.announcements : [];
  feed.schemaVersion = 1;
  feed.announcements = [announcement, ...announcements].slice(0, 30);
  const content = Buffer.from(`${JSON.stringify(feed, null, 2)}\n`, "utf8").toString("base64");
  runGh(["api", `repos/${repository}/contents/announcements.json`, "--method", "PUT", "-f", `message=chore: publish announcement ${id}`, "-f", `sha=${response.sha}`, "-f", `content=${content}`]);
  console.log(`Published ${id}. Users receive it when 花海画布 next starts or opens 公告.`);
} catch (error) {
  console.error(`Announcement not published: ${error.message}`);
  console.error("Run 'gh auth login' for the correct GitHub account, then retry. This script never writes a GitHub token into the project.");
  process.exit(1);
}
