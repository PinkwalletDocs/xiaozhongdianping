# 我不会部署后端：用 Render「一键」部署（仍需你登录一次）

我无法代替你登录 Render 或输入密钥，但可以让你在 **5～10 分钟内** 把后端跑起来。

## 你需要准备

1. GitHub 账号（代码已在仓库里）
2. Render 账号（用 GitHub 登录即可）
3. 一张可绑定的支付方式（本 Blueprint 使用 **Starter + 1GB 磁盘**，SQLite 才能长期保留；若你只想试跑，可在 Render 里把服务改成 Free 并删除磁盘配置，但数据可能丢失）

## 一键部署（推荐）

1. 打开（把 `你的仓库` 换成实际地址，例如 `PinkwalletDocs/xiaozhong`）：

   `https://render.com/deploy`

2. 选择 **Blueprint** 或 **New Web Service** → **Connect repository** → 选中本仓库。
3. 若使用 Blueprint：Render 会读取仓库根目录的 `render.yaml`。
4. 部署向导里会要求你填写 **sync: false** 的环境变量：
   - `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET`（与 X 开发者后台一致）
   - `BASE_URL`：**填你的 Vercel 前端域名**（例如 `https://xxx.vercel.app`，不要末尾 `/`）
   - `ADMIN_TWITTER_HANDLES`：管理员 X 用户名（不含 `@`，逗号分隔）
5. `SESSION_SECRET` / `JWT_SECRET` 已在 Blueprint 里设为 **自动生成**；你也可以在面板里改成自己写的长随机串。
6. 点击 **Create** / **Deploy**。

部署成功后你会得到一个后端地址，例如：

`https://xiaozhong-api.onrender.com`

## 和 Vercel 前端对接

1. 在 **Vercel** 项目 → **Settings** → **Rewrites** 添加两条（把 `后端域名` 换成上一步的 Render 地址）：

   - Source：`/api/(.*)`  
     Destination：`https://后端域名/api/$1`

   - Source：`/uploads/(.*)`  
     Destination：`https://后端域名/uploads/$1`

2. 确保 Render 里 `BASE_URL` 仍是你的 **Vercel 域名**（OAuth 回调必须一致）。

3. 在 X 开发者后台添加回调：

   `https://你的Vercel域名/api/auth/twitter/callback`

## 验证

- 浏览器打开：`https://你的Vercel域名/api/health`  
  应返回 JSON，`ok: true`。

若某一步卡住，把 **Render 部署日志最后 30 行** 或 **Vercel 报错全文** 发我即可。
