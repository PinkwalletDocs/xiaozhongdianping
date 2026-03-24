/**
 * 仅在 Linux（含 Vercel 构建机）上重建 better-sqlite3，确保部署包内是 ELF 可用的 .node。
 * Windows/macOS 本地开发跳过，避免锁文件/重复编译干扰日常 npm install。
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "linux") {
  process.exit(0);
}

const root = path.join(__dirname, "..");
if (!fs.existsSync(path.join(root, "node_modules", "better-sqlite3"))) {
  process.exit(0);
}

try {
  execSync("npm rebuild better-sqlite3", {
    stdio: "inherit",
    cwd: root
  });
} catch (e) {
  console.warn("[postinstall-native] rebuild failed:", e && e.message ? e.message : e);
  process.exit(0);
}
