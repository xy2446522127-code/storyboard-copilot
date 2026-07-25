# 花海画布更新与发布

花海画布使用 GitHub Releases 作为稳定更新源。程序启动后会静默检查一次，也可点击右下角的“检查更新”。发现新版本后，只有用户确认才会下载和安装；Windows 会显示安装进度。更新包必须通过内置公钥的签名验证，验证失败不会覆盖当前安装。

## 不会被更新触碰的数据

- 用户项目数据库、素材库、下载文件和本地设置不在安装目录中；更新安装程序不会删除它们。
- 程序标识 `cc.zhiyao.storyboard-copilot` 保持不变，以兼容已有项目数据和安装记录。
- API 密钥和登录状态不应写进仓库、安装包、Release 说明或截图。

## 一次性准备

1. 生成更新签名私钥和密码文件，并保存到仓库以外的本机安全位置。
2. 将公钥内容写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
3. 永远分别备份私钥和密码文件。丢失其中任一文件后，已安装版本将无法验证任何新的更新包；不要通过 Git、聊天记录或邮件发送它们。

## 每次发布

1. 将版本号同步更新到 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与 `package.json`，必须是标准 SemVer，例如 `5.6.1`。
2. 编写本次变更说明，例如 `release-notes.md`。
3. 运行 `scripts\\build-release.cmd <私钥路径>`，脚本会从同目录的 `<私钥路径>.password` 读取本机密码，生成 NSIS 安装包和其 `.sig` 签名文件。
4. 以安装包及 `.sig` 为输入运行 `scripts\\make-updater-manifest.mjs`，生成 `latest.json`。
5. 用 GitHub Release 发布同一个标签（如 `v5.6.1`），上传安装包与 `latest.json`。发布后，下载 `latest.json` 并核对版本、URL 和签名；在一台装有旧版本的测试机上点击更新并确认项目仍在。

## 发布前检查

- 确认没有误把私钥、API Key、项目数据库、用户素材或测试产物提交到 Git。
- 确认 Release 不是草稿，`latest.json` 的 URL 指向同一标签下的实际文件。
- 确认升级包的文件名和 `.sig` 是同一次构建产生的，不能交叉使用。
- 保留上一版 Release，不要覆盖或删除；出现问题时可快速重新发布修复版。
- 在断网、代理失败、磁盘不足和权限不足情况下，程序应显示失败提示，现有版本仍可继续使用。
