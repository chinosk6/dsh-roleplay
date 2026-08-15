# dsh-roleplay

- DeepSeek Harness 角色扮演插件



# 环境要求

- [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) **0.1.0-rc.6+**、
- Node **22.19+**
- [pnpm](https://pnpm.io/) **9+**



# 安装

### 从 npm

```bash
dsh plugin --profile web add -w dsh-roleplay
```

### 从 GitHub

```bash
dsh plugin --profile web add -w github:chinosk6/dsh-roleplay
```

也可指定分支或 tag：

```bash
dsh plugin --profile web add -w github:chinosk6/dsh-roleplay#v0.1.0
```

Git 安装会跑本包的 `prepare` 来构建 `lib/`。若 pnpm 提示忽略了 build script，在 `~/.dsh/profiles/web/pnpm-workspace.yaml`加上：

```yaml
allowBuilds:
  dsh-roleplay: true
```

然后把同一条 `add` 命令再跑一遍。

### 从本地目录

```bash
git clone https://github.com/chinosk6/dsh-roleplay.git
cd <repo>
pnpm install
pnpm run build
dsh plugin --profile web add -w .
```



## 更新

```bash
dsh plugin --profile web update dsh-roleplay
```

然后重启 dsh。

本地目录安装没有“拉远程”这一步：在仓库里 `git pull` → `pnpm install` → `pnpm run build` → 重启即可。



## 卸载

```bash
dsh plugin --profile web remove dsh-roleplay
```

- 角色卡和生成图片的缓存仍留在 `$DSH_HOME/roleplay/`，需要手动清除



# 构建

```bash
pnpm install
pnpm run build
```

Windows 上若 `npx` / `pnpm` 被执行策略拦住，可直接：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node scripts/build.mjs
```

添加本地仓库到 dsh

```bash
dsh plugin --profile web add -w .
```

之后重启 dsh web



# 致谢

- 支持导入 [RP-Hub](chinosk6/dsh-roleplay) 角色卡，部分提示词参考了此项目。
