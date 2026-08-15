# dsh-roleplay

[English](README-EN.md) | [简体中文](README.md)

- DeepSeek Harness 角色扮演插件



# 功能

- 角色卡生成 / 导入，支持交互式创建角色卡

- 图片生成，支持：
  - NAI 官方接口
  - ai.erp.sex 三方接口
  - Stable Diffusion WebUI 本地接口



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

Git 安装会运行 `prepare` 来构建 `lib/`。若 pnpm 提示忽略了 build script，在 `~/.dsh/profiles/web/pnpm-workspace.yaml`加上：

```yaml
allowBuilds:
  dsh-roleplay: true
```



## 更新

```bash
dsh plugin --profile web update dsh-roleplay
```

然后重启 dsh。



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

- 支持导入 [RP-Hub](https://github.com/STA1N156/RP-Hub) 角色卡，部分提示词参考了此项目。
