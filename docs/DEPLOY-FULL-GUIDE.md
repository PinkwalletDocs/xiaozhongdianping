# 小众点评：完整部署教程（Vercel 前端 + 持久后端）

本文给出一套**可长期用、数据不随便丢**的推荐架构，并说明可选方案与验证步骤。按顺序做即可。

---

## 一、架构说明（先读这一段）

| 组件 | 推荐做法 | 原因 |
|------|----------|------|
| 前端静态资源 | **Vercel** 托管 `dist/`（或 `npm run build` 生成） | CDN、HTTPS、域名简单 |
| 业务 API + SQLite + 上传文件 | **Render（付费盘）/ VPS** 等常驻环境 | SQLite 和 `uploads/` 需要**可持久磁盘**；纯 Vercel Serverless 不适合当「唯一数据库」 |
| 浏览器里的请求地址 | 始终用 **同一域名** 访问：`https://你的Vercel域名` | 前端用 `fetch('/api/...')`；Vercel 用 **Rewrites** 把 `/api/*`、`/uploads/*` 转到后端 |

**推荐路径（本文主流程）：**

1. 先把**后端**部署到 Render（或 VPS），拿到 `https://xxx.onrender.com` 之类地址。  
2. 再把**前端**部署到 Vercel，`BASE_URL` 填 **Vercel 前端域名**。  
3. 在 Vercel 配 **两条** Rewrites：`/api/*` 与 **`/uploads/*`**。  
4. 在 X Developer 里把回调设为 **`https://你的Vercel域名/api/auth/twitter/callback`**。

> **为什么不建议「只靠 Vercel 跑完整 Express + SQLite」当正式站？**  
> Serverless 实例上的本地盘多为临时或只读，**数据与上传难以长期可靠保存**。演示可以，正式用请把 API 放在有持久盘的环境，或改用托管数据库 + 对象存储（需改代码，本仓库当前以 SQLite 为主）。

---

## 二、开始前准备

1. **GitHub 仓库**：代码已推送（本机 `git push` 完成）。  
2. 账号：**Vercel**、**Render**（或一台可 SSH 的 **VPS**）。  
3. **X Developer**：已创建 **OAuth 2.0 Web App**，能拿到 **Client ID / Client Secret**。  
4. 记下两个将来要用的地址（先占位即可）：  
   - `FRONTEND_URL` = 例如 `https://xiaozhong.vercel.app`（部署 Vercel 后确定）  
   - `BACKEND_URL` = 例如 `https://xiaozhong-api.onrender.com`（部署后端后确定）

---

## 三、后端部署（必须先有可用的 `/api/health`）

### 方案 A：Render（与仓库内 `render.yaml` 一致）

1. 打开 [Render Dashboard](https://dashboard.render.com/)，用 GitHub 登录。  
2. **New** → **Blueprint**（或 **Web Service**）→ 连接本仓库。  
3. 若使用 Blueprint，会读取根目录 `render.yaml`。  
4. 在向导中填写 **Secret / 同步为 false** 的变量（名称以面板为准）：  
   - `TWITTER_CLIENT_ID`、`TWITTER_CLIENT_SECRET`（与 X 控制台一致）  
   - **`BASE_URL`**：填 **Vercel 前端域名** `https://xxx.vercel.app`（**不要**末尾 `/`）。若此时还不知道 Vercel 域名，可先填计划使用的域名，部署完 Vercel 后再回来改成最终值。  
   - `ADMIN_TWITTER_HANDLES`：管理员 X 用户名，不含 `@`，多个用英文逗号分隔  
5. `SESSION_SECRET`、`JWT_SECRET` 可用 Render 自动生成，或自己填长随机串（**部署后勿随意改**，否则已登录 Cookie 会失效）。  
6. 磁盘：`render.yaml` 里示例为 **Starter + 持久盘**（SQLite 长期保留需要磁盘；**免费 Web 实例无持久盘**，数据可能在休眠/重部署后丢失，仅适合试跑）。

部署成功后，在浏览器访问：

```text
https://你的后端域名/api/health
```

应返回 JSON，且含 `"ok": true`（或等价健康字段）。

更细的 Render 说明见：`docs/DEPLOY-RENDER-ONE-CLICK.md`。

### 方案 B：自有 VPS

1. 服务器安装 **Node 20+**，克隆仓库，`npm install`。  
2. 配置环境变量（至少与 `.env.example` 一致，见下文「环境变量清单」）。  
3. **`BASE_URL` 仍填 Vercel 前端域名**（不是 VPS IP）。  
4. `npm start` 或 `node server.js`，默认端口 `PORT=3001`（可用 Nginx/Caddy 反代到 443）。  
5. 保证 `data/`、`uploads/` 在重启后仍在（同一台机同一目录即可）。

详细步骤见：`docs/DEPLOY-BACKEND-VERCEL-PROXY.md`。

---

## 四、Vercel 前端部署

### 4.1 创建项目

1. 打开 [Vercel](https://vercel.com/) → **Add New** → **Project** → 导入同一 GitHub 仓库。  
2. **Framework Preset**：选 **Other** 或 **Static**（以当前界面为准）。

### 4.2 构建设置（Project Settings → Build & Output）

| 项 | 值 |
|----|-----|
| **Install Command** | `npm install`（默认即可） |
| **Build Command** | `npm run build`（会执行 `scripts/build-dist.js` 生成 `dist/`） |
| **Output Directory** | `dist` |

说明：构建产物在 `dist/`，内含混淆后的 `frontend.obf.js` 等。仓库里若已有旧 `dist/`，仍建议每次用构建生成，避免与源码不一致。

### 4.3 环境变量（仅当前端需要调环境时）

纯静态托管时，**前端一般不把密钥放进 Vercel**；**Twitter 密钥只放在后端**（Render/VPS）。

若你将来给构建脚本注入变量，再单独在 Vercel 里加；默认按仓库现有 `frontend.js`（`API_BASE = "/api"`）即可。

---

## 五、把前后端「接成同一域名」（必做）

用户浏览器只访问 **Vercel 域名**，但 API 实际由后端处理。因此在 Vercel：

**Settings → Rewrites** 增加两条（把 `BACKEND_URL` 换成你的后端根地址，**无尾部斜杠**）：

| Source | Destination |
|--------|-------------|
| `/api/(.*)` | `https://你的后端域名/api/$1` |
| `/uploads/(.*)` | `https://你的后端域名/uploads/$1` |

**第二行必配**：爆料证据图片/视频 URL 形如 `/uploads/xxx`，不配会 404。

详细说明见：`docs/DEPLOY-VERCEL-REWRITES.md`。

---

## 六、X（Twitter）OAuth 配置

OAuth 回调由后端根据环境变量 **`BASE_URL`** 拼接，必须为：

```text
{BASE_URL}/api/auth/twitter/callback
```

上线后 **`BASE_URL` 必须是你的 Vercel 前端**，例如：

```text
https://xiaozhong.vercel.app/api/auth/twitter/callback
```

在 [X Developer Portal](https://developer.x.com/) → 你的 App → **User authentication settings** → **Callback URI** 中**逐字添加**上面这一行（`https`、域名、路径都不能错）。

权限（Scopes）需与代码一致：`tweet.read users.read offline.access`。

完整说明见：`docs/X-OAUTH-SETUP.md`。

### 登录态说明（避免再踩坑）

服务端已使用 **签名 Cookie** 保存 OAuth PKCE 与登录用户，适配 **Vercel / 多实例**。仍请保证：

- 用户始终从 **同一个 Vercel 域名** 打开站点（不要混用 `www` 与裸域除非都配好）。  
- **`BASE_URL`、X 控制台回调、浏览器地址栏域名** 三者一致。

---

## 七、环境变量清单（后端）

部署在 **Render / VPS** 的后端至少需要：

| 变量 | 说明 |
|------|------|
| `TWITTER_CLIENT_ID` | X OAuth Client ID |
| `TWITTER_CLIENT_SECRET` | X OAuth Client Secret |
| `BASE_URL` | **`https://你的Vercel域名`**，无尾部 `/` |
| `SESSION_SECRET` | 长随机串；用于 Cookie 签名（与 `cookie-parser` 共用逻辑） |
| `JWT_SECRET` | 管理后台 JWT；未设 `SESSION_SECRET` 时也会参与 Cookie 密钥回退 |
| `ADMIN_TWITTER_HANDLES` | 管理员 X 用户名，逗号分隔，不含 `@` |

可选：链上捐赠相关 `ETH_RPC_URL`、`TREASURY_WALLET` 等（见 `.env.example`）。  
可选：`RAPIDAPI_KEY` 用于粉丝同步与头像等。

本地复制模板：`.env.example`。

---

## 八、部署后验证（建议按顺序勾完）

1. **健康检查**  
   - 打开：`https://你的Vercel域名/api/health`  
   - 应经 Rewrite 转到后端并返回 JSON。

2. **X 登录**  
   - 首页点 **X 登录** → 授权 → 回到站点后应显示已登录。  
   - F12 → Network：`/api/auth/twitter`、`/api/auth/twitter/callback`、`/api/auth/me` 应成功。

3. **爆料 + 证据**  
   - 提交带图片/视频的爆料，列表里证据能打开（测 `/uploads/` Rewrite）。

4. **评论 / 投票**（按需）  
   - 发评论、刷新仍在；投票按业务规则测试。

更细检查表见：`docs/DEPLOY-VERIFY-PROXY.md`。

---

## 九、常见问题

| 现象 | 处理方向 |
|------|----------|
| `GET /` 404 或空白 | 确认 Vercel **Output Directory = `dist`**，且 `npm run build` 成功 |
| `/api/health` 404 | Rewrites 未生效或 Destination 写错；检查后端是否可直接访问 `/api/health` |
| X 授权后仍显示未登录 | `BASE_URL` 与 X 回调不一致；或混用域名；或只配了 `/api` 没走 Vercel |
| 证据图 404 | 补 **`/uploads/(.*)`** 这条 Rewrite |
| 榜单一直空 | 后端 SQLite 是否持久、是否执行过种子数据；免费实例休眠后冷启动第一次较慢 |
| 503 Twitter login | 后端未配置 `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` |

---

## 十、相关文档索引

| 文档 | 内容 |
|------|------|
| `docs/X-OAUTH-SETUP.md` | X OAuth 与 `.env` 字段说明 |
| `docs/DEPLOY-VERCEL-FRONTEND.md` | Vercel 静态与 build 说明 |
| `docs/DEPLOY-VERCEL-REWRITES.md` | Rewrites 规则 |
| `docs/DEPLOY-BACKEND-VERCEL-PROXY.md` | 后端为何放在外置环境、`BASE_URL` 含义 |
| `docs/DEPLOY-RENDER-ONE-CLICK.md` | Render 一键部署要点 |
| `docs/DEPLOY-VERIFY-PROXY.md` | 代理与功能验证 |
| `render.yaml` | Render Blueprint 示例（含磁盘与路径） |

---

## 十一、可选：整站都挂在 Vercel Serverless（不推荐作唯一生产库）

仓库含 `index.js` 导出 `server.js`，Vercel 可把 Express 当函数跑，并配合 `vercel.json` 中的 `buildCommand` 等。但 **SQLite + 本地上传** 在无持久盘时不可靠。若仅作演示，请接受数据可能丢失；正式环境请回到**第一节推荐架构**。
