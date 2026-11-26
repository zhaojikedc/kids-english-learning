# 小树英语 · 复习本

Kids' English review app / 给三年级、剑桥少儿英语二级（Movers）用的复习网页。

可以在电脑和手机上复习单词、语法和例句，把拍到的课本页交给模型拆成卡片，围绕已经录入的卡片聊天，并在看板上看这一周的情况。复习节奏在浏览器里按间隔重复计算。

线上跑在 **Cloudflare Workers**：页面是静态资源，`/api/*` 由同一个 Worker 处理。卡片、聊天、日志、周总结存在 **D1**，课本图片和周总结 Markdown 存在 **R2**。本地开发仍然是 `node server.js`，数据还在本机文件里。

## 本地运行

运行服务需要 Node.js 18 或更新版本（用内置的 `fetch`）。`npm test` 需要 Node.js 22 或更新版本，测试会用内置的 `node:sqlite` 核对 D1 的表。

```bash
npm install
# 密钥只放在环境变量里。不要写进文件再提交。
DEEPSEEK_API_KEY="你的密钥" node server.js
```

浏览器打开 <http://127.0.0.1:8787/>。

- 端口用 `PORT` 改，监听地址用 `HOST` 改。默认端口 `8787`，默认监听 `::`。
- 没设置环境变量时，本机服务会再试一次 `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`。这只给原来的 Mac 开发机用。**Cloudflare Worker 不会读这个文件。**
- 卡片等运行数据写在 `data/`（已忽略，不要提交）。课本图片写到 `~/Desktop/个人知识库/05-课本图片`。周总结 Markdown 写到 `~/Desktop/个人知识库/03-项目/小树英语`。
- 本机直接打开时，看板「外网访问」能看到访问码。请求如果带了 `x-forwarded-for` 或 `cf-connecting-ip`（例如 cloudflared 临时隧道），接口就要求 `x-access-code`。

自测：

```bash
npm test
```

`test_logic.js` 检查间隔重复和跟读对比。`test_api.js` 检查本地 HTTP、D1 形状的读写，以及识图任务。

## 部署到 Cloudflare

配置在 `wrangler.jsonc`。一次 `wrangler deploy` 会发布静态页面和 API。

| 绑定 | 类型 | 名称 | 用途 |
| --- | --- | --- | --- |
| `DB` | D1 | `kids-english-learning` | 卡片、聊天、日志、档案、周总结、默认设置、识图任务。没设置 `ACCESS_CODE` 时，自动生成的访问码也在这里 |
| `BUCKET` | R2 | `kids-english-learning` | 课本页图片 `images/`，周总结 `knowledge-base/weekly/`，以后的知识库文档放 `knowledge-base/docs/` |
| `ASSETS` | Workers 静态资源 | `public/` | 页面、脚本、样式、图标 |
| `MODEL` | 变量 | `deepseek-flash` | 聊天模型，不是密钥 |
| `OCR_MODEL` | 变量 | `deepseek-chat` | 识图模型，不是密钥 |
| `DEEPSEEK_API_KEY` | Secret | | DeepSeek 密钥。用 `wrangler secret put` 或 `--secrets-file` 设置 |
| `ACCESS_CODE` | Secret，可选 | | 公网访问码。不设置时，第一次需要校验的请求会在 D1 里生成一个 6 位数 |

Workers 有日志和 trace（`observability` 已打开）。

### 和现有 Pages 项目的关系

账号里已经有一个叫 `kids-english-learning` 的 **Cloudflare Pages** 项目，创建方式是 **Direct Upload**。Direct Upload 项目不能再改成 Git 集成。不要给那个项目接 Git，也不要试图把它「转换」成这个仓库的部署目标。

这个仓库部署的是 **Worker + 静态资源**，和那个 Pages 项目是两种产品，名字可以相同，互不修改。`wrangler deploy` 不会往那个 Pages 项目里上传文件。

如果一定要 Pages 的 Git 自动部署，需要**新建**一个 Git 连接的 Pages 项目。那样还要自己接上这里的 Worker 接口、D1 和 R2，本仓库没有按那条路配。只把 `public/` 用 `wrangler pages deploy` 传到现有的 Direct Upload 项目，页面在，但没有 `/api`、D1 和 R2。

部署成功后，Wrangler 会打印 `*.workers.dev` 地址。地址里的子域名是账号自己的，仓库里不写死。

### 第一次部署

在仓库根目录：

```bash
npm install
npx wrangler login
npx wrangler d1 create kids-english-learning --update-config
npx wrangler r2 bucket create kids-english-learning
npx wrangler d1 migrations apply kids-english-learning --remote
```

`d1 create --update-config` 会把真实的 `database_id` 写进 `wrangler.jsonc`。配置里故意先不填 id，避免放一个假的数据库。

复制 `.dev.vars.example` 为 `.dev.vars`，填上密钥。`.dev.vars` 已经在 `.gitignore` 里。

```bash
# .dev.vars 示例（不要提交真实内容）
# DEEPSEEK_API_KEY=...
# ACCESS_CODE=家里自己定的一串
npx wrangler deploy --secrets-file .dev.vars
```

也可以分两次写密钥。`secret put` 会立刻发布一个新版本：

```bash
npx wrangler deploy
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put ACCESS_CODE
```

不要把密钥写进 `wrangler.jsonc` 的 `vars`，也不要写进前端。

本地用 Wrangler 看绑定后的接口：

```bash
npx wrangler d1 migrations apply kids-english-learning --local
npx wrangler dev
```

`wrangler dev` 读 `.dev.vars`。`node server.js` 不读这个文件。

### 访问码

公网上的 `/api/*`（除了 `/api/health`）要带请求头 `x-access-code`。页面会把本机保存的码自动带上，第一次会弹出输入框。

请自己设置 `ACCESS_CODE`。站点在公网，而且聊天和识图会花 DeepSeek 的额度，6 位数字偏短。不设置时，Worker 会生成一个 6 位数并存进 D1，本机看板看不到它（Cloudflare 请求都带 `cf-connecting-ip`）。需要时再查，查出来的是访问码，不要贴到公开场合：

```bash
npx wrangler d1 execute kids-english-learning --remote \
  --command "SELECT value FROM meta WHERE key = 'access';"
```

### 空数据

迁移 `migrations/0001_init.sql` 会建表，并写入默认每日目标：每天 10 张，其中单词 4、语法 3、例句 3、其他 0。卡片、聊天、日志、周总结都是空的。这里没有示例课文。

### 计划

Workers Free 的 CPU 时间是 10ms，等待网络（包括等 DeepSeek）不计 CPU。拍照识图要在 Worker 里解码图片，可能超过 10ms，出现错误 1102。聊天这种小请求更容易留在免费额度里。要稳定识图，用 **Workers Paid**，然后在 `wrangler.jsonc` 里加上 `"limits": { "cpu_ms": 30000 }` 再部署。付费计划默认 CPU 是 30 秒，最高 5 分钟。

识图在返回 `/api/ocr-cards` 之前做完，因为 `waitUntil` 在响应发出后只有大约 30 秒，不够看完几张课本页。页面会一直等这次提交，不要关掉。

### 知识库文档放 R2

不要把课本 PDF、课本照片或周总结放进 `public/`，也不要当成 Pages / Workers 的静态文件发布。静态目录只有页面、脚本、样式和图标。

R2 桶 `kids-english-learning` 的前缀：

| 前缀 | 内容 |
| --- | --- |
| `images/` | 识图时保存的课本页，卡片上的 `/images/文件名` 由 Worker 从这里读 |
| `knowledge-base/weekly/` | 生成周总结时写的 `周总结-YYYY-MM-DD.md` |
| `knowledge-base/docs/` | 留给以后要放进知识库的文档。用 `wrangler r2 object put` 上传到这个前缀，不要提交到仓库 |

本地 `node server.js` 仍把图片和周总结写在上面的桌面知识库目录，不写进 R2。

## 目录

- `public/`：页面。`server.js` 和 Worker 都从这里发静态文件。
- `server.js`：本地 Node 服务。
- `src/index.js`：Worker 入口。
- `lib/`：两边共用的接口、识图和存储。
- `migrations/`：D1 表结构和默认设置。
- `mac/`：原来的 macOS LaunchAgent，路径是那台 Mac 上的。开机自启和 cloudflared 临时隧道都不是线上的跑法，仓库里也没有 `bin/cloudflared`。
- `启动小树英语.command`：在 Mac 上双击，执行 `node server.js` 并打开浏览器。

## 没有放进仓库的东西

这个仓库是公开的。下面这些不能提交：

- `data/` 里的卡片、档案、日志、周总结、聊天、访问码
- `.env`、`.dev.vars`、API 密钥、`~/.dsh/.credentials.yaml`
- 孩子的照片。页面头像是绘制的树苗 `public/avatar.svg`，主屏幕图标是橙色「英」字，不是照片
- 课本页图片。识别出来的图片只进本机知识库目录或 R2
- AppleDouble `._*` 和 `bin/cloudflared`
