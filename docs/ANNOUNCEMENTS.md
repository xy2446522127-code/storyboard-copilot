# 花海画布公告发布与同步

花海画布启动时会从仓库主分支的 `announcements.json` 拉取公告；用户也可以从左侧的“公告”重新同步。公告不含密钥、不需要用户登录，也不会写入 C 盘，已读状态仅保存在花海画布的 F 盘 WebView 数据目录。

## 发布公告

先在这台电脑上用项目拥有者账号完成一次 `gh auth login`。随后在项目目录执行：

```powershell
node scripts/publish-announcement.mjs --title "版本更新" --body "5.7.4 已发布，包含公告同步和大画布性能保护。" --level success
```

可选参数：`--url https://...` 用于详情链接；`--expires-at 2026-12-31T00:00:00Z` 用于到期自动隐藏。可用级别为 `info`、`success`、`warning`、`error`。

脚本会通过 GitHub CLI 直接更新 `main` 分支的 `announcements.json`。所有联网用户下次启动花海画布、或打开“公告”时都会收到同一份公告。GitHub 登录令牌由 GitHub CLI 自己的凭据管理保存，项目、Git 历史和应用设置都不会保存令牌。

## 删除或撤回公告

在 GitHub 网页中编辑 `announcements.json`，删除对应对象后提交即可；也可以使用 Git 提交该文件。客户端会在下一次同步时不再显示该公告。新版客户端只读取此文件，**不会读取旧版知瑶画布的公告源**。
