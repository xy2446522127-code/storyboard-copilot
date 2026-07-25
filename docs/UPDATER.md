# 花海画布更新发布

花海画布通过 GitHub Releases 提供更新。应用启动时会检查更新，用户也可以使用“检查更新”；只有用户确认后才下载和安装。更新包必须使用与 `src-tauri/tauri.conf.json` 中公钥匹配的私钥签名，签名验证失败不会覆盖现有版本。

## 数据与安装边界

- 应用标识符为 `com.huahai.canvas`。
- 项目数据库、素材索引、聊天记录、API 设置与 WebView 数据固定在 `F:\Huahaihuabu\花海画布`，不在安装目录，也不写入 C 盘。
- 私钥、私钥口令、API Key、Cookie、用户项目和构建产物不得提交到 Git 或上传到 Release。

## 每次发布

1. 将 `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 与 `package.json` 的版本号同步为新的 SemVer 版本。
2. 在 F 盘准备构建缓存和临时目录，并运行 `scripts/verify-and-commit.ps1`。它会执行 Rust/前端/命令覆盖检查与密钥扫描。
3. 运行 `scripts/build-release.cmd <私钥文件路径>`。私钥和其 `.password` 文件只能保存在仓库外的安全位置。
4. 使用 `scripts/make-updater-manifest.mjs` 为同一构建生成 `latest.json`，并将 NSIS 安装包、`.sig` 和 `latest.json` 上传到同一 GitHub Release。
5. 下载发布后的 `latest.json`，确认版本、下载 URL 和签名正确；在已有版本上执行一次更新回归，确认项目、聊天历史和 API 设置保持可用。

更新失败、断网、磁盘不足或权限不足时，应用应显示可理解的错误，但必须继续保留并启动当前版本。
