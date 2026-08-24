# 部署与发布说明

本文档说明 `pi-failover` 的发布流程。当前 GitHub 仓库的自动发布由
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) 在 GitHub
Release 发布时触发；Release tag 必须是 `v<package.json version>`。

## 前置条件

- 具备仓库 push、GitHub Release 和 npm 发布权限。
- 仓库已配置 `NPM_TOKEN` secret。
- 本地已安装并认证 `npm`、`git`、`gh`。

```bash
gh auth status
git remote -v
```

## 发布

在 `main` 的干净工作区更新版本。`--no-git-tag-version` 保持 tag 创建由后续
步骤显式控制。

```bash
git checkout main
git pull origin main
npm version patch --no-git-tag-version
npm ci
npm test
npm run typecheck
npm pack --dry-run
git add package.json package-lock.json
git commit -m "release: v$(node -p \"require('./package.json').version\")"
git push origin main
```

创建 tag 和 Release：

```bash
TAG="v$(node -p \"require('./package.json').version\")"
git tag -a "$TAG" -m "release: $TAG"
git push origin "$TAG"
gh release create "$TAG" --title "$TAG" --generate-notes
```

工作流再次执行 `npm ci`、`npm test`、`npm run typecheck` 和
`npm pack --dry-run`，随后发布 `pi-failover`。确认 npm 发布成功后，弃用旧包：

```bash
npm deprecate '@gooyoung/pi-keyrouter@*' 'Deprecated: migrate to pi-failover'
```

## 发布后检查

```bash
gh run list --workflow publish.yml --limit 5
npm view pi-failover version
```

不要在同一版本上重复发布；npm 不允许覆盖既有版本。
