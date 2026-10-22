# AliMPay Bun

面向单用户、单实例部署的支付宝收款网关，也是供现有系统直接接入的易支付 API 兼容层。一个 Bun 进程同时提供 React 管理后台、公开收银台、易支付 V1/V2 兼容接口、支付宝 V3 账务明细查询和支付通知队列。

## 已实现

- Bun + Hono 后端、React 19 + Vite + Tailwind CSS 前端
- SQLite WAL 持久化，不依赖 MySQL、Redis 或 ORM
- 首次启动设置固定管理员 `admin`，密码使用 Argon2id
- 支付宝 V3 `alipay.data.bill.accountlog.query`，由官方 `alipay-sdk` 负责 RSA2 请求和响应验签
- 经营码精确金额匹配：为订单事务性分配原金额，原金额被占用时再依次增加 `+0.01` 至 `+0.99` 元
- 转账备注兼容模式：标准支付宝转账 URI，订单号写入 `memo`
- 转账链接保留从内到外三层供后台选择；第 1 层为原始 `alipays://`，第 2 层为已验证可用的单层支付宝 HTTPS，第 3 层为外层支付宝 Scheme
- 支付轮询间隔可在后台设置为 1–60 秒，并同步作用于服务端扫账、收银台状态查询和易支付订单查询
- 手机浏览器打开有效的转账模式收银台时自动唤起支付宝，页面按钮保留为浏览器拦截时的手动兜底
- 易支付 V1 MD5：下单、页面支付、商户信息、单笔与批量订单查询、同步返回、异步通知
- 易支付 V2 RSA：下单、页面支付、订单查询、商户信息、订单列表、同步返回、异步通知
- 支付通知首次立即发送，失败后每 60 秒一次，自动任务最多 10 次
- 独立密钥中心：支付宝应用、V1、V2 平台、V2 商户四个信任方向不复用密钥
- 订单、支付流水、扫描运行、通知尝试和后台操作审计
- Docker/Compose、健康检查、桌面与移动端界面

不实现退款、代付、关单、结算和多商户。旧 PHP 版本的数据不会自动迁移。

## 工作方式

每个收银台有效 5 分钟，但订单会继续被有限监控至创建后第 10 分钟：

1. 没有待确认订单时，不请求支付宝。
2. 存在待确认订单时，全实例最多每 5 秒发起一轮合并账务查询，而不是每个订单单独查询。
3. 经营码按收入方向、唯一实付金额和发生时间匹配。
4. 转账模式额外要求 `trans_memo` 等于商户订单号。
5. 第 5–10 分钟到账记为 `late_paid`，对易支付接口仍映射为 `status=1` 并正常通知。
6. 第 10 分钟后停止自动匹配，过期订单与审计数据保留。

## 本地运行

要求 Bun 1.3 或更高版本。

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

- 前端开发地址：`http://localhost:5173`
- 后端地址：`http://localhost:3000`
- 生产构建：`bun run build && bun start`

首次启动会自动生成 32 字节随机主密钥，并以 `0600` 权限保存到 `DATA_DIR/.master-key`。`APP_MASTER_KEY` 不是支付宝应用私钥或易支付签名密钥，而是本程序用来加密数据库敏感字段的内部根密钥，通常无需手工设置。

只有在使用外部密钥管理系统时才需要显式设置 `APP_MASTER_KEY`，格式为 32 字节 Base64 或 64 位十六进制：

```bash
openssl rand -base64 32
```

一旦后台已经保存密钥，不要删除 `.master-key`，也不要在文件密钥和环境变量之间切换，否则已有加密数据将无法解密。

## 直接部署 Bun（推荐）

下面以 Linux、代码目录 `/opt/AliMPay`、监听 `127.0.0.1:3000` 为例。先安装 Bun 1.3 或更高版本，然后执行：

```bash
git clone https://github.com/MiaM1ku/AliMPay.git /opt/AliMPay
cd /opt/AliMPay
bun install --frozen-lockfile
cp .env.example .env
```

编辑 `.env`，至少把 `PUBLIC_BASE_URL` 改成实际 HTTPS 域名；`APP_MASTER_KEY` 保持空白即可自动生成。然后构建并试运行：

```bash
bun run build
bun run start
```

确认 `curl -fsS http://127.0.0.1:3000/healthz` 返回正常后，可配置 systemd。先用 `command -v bun` 确认 Bun 的绝对路径，并按实际运行账户修改下面的 `User` 和 `ExecStart`：

```ini
# /etc/systemd/system/alimpay.service
[Unit]
Description=AliMPay Bun gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/AliMPay
EnvironmentFile=/opt/AliMPay/.env
ExecStart=/home/YOUR_USER/.bun/bin/bun run start
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now alimpay
sudo systemctl status alimpay
sudo journalctl -u alimpay -n 100 --no-pager
```

只运行一个应用进程。当前实现的扫描合并与通知认领以单进程为边界，不支持多副本横向扩容。

## Docker Compose（可选）

创建 `.env`：

```dotenv
PUBLIC_BASE_URL=https://pay.example.com
# APP_MASTER_KEY 可留空，由程序首次启动自动生成
```

启动：

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/healthz
```

Compose 默认只把端口绑定到 `127.0.0.1:3000`，应由 Caddy、Nginx 或其他 HTTPS 反向代理对外提供服务。Nginx 最小配置示例：

```nginx
server {
    listen 443 ssl http2;
    server_name pay.example.com;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
}
```

无论直接运行还是使用 Compose，都应把 `data` 目录放在持久磁盘并纳入备份。

## 隐藏管理入口

生产环境（`NODE_ENV=production`）默认隐藏首页和后台：未取得入口凭证的浏览器访问 `/`、`/login`、`/setup`、管理页面或 `/admin-api/*` 均返回 404。收银台 `/checkout/:token`、收银台查询、经营码图片、易支付 V1/V2 接口以及 `/healthz`、`/readyz` 保持可用，支付匹配和通知任务继续运行。

首次启动会在持久化数据目录生成随机入口 `.admin-entry-path`。通过服务器查看：

```bash
# 直接部署，在项目目录执行（自定义 DATA_DIR 时使用实际目录）
cat data/.admin-entry-path

# Docker Compose
docker compose exec alimpay cat /data/.admin-entry-path
```

将输出路径拼在域名后，例如 `https://pay.example.com/admin-<随机值>`。打开后跳转至首页，浏览器获得有效期 30 天的签名 HttpOnly Cookie；后台仍需要管理员密码和 CSRF 校验。无痕窗口、新设备或凭证过期后，重新打开此入口即可。

也可以在 `.env` 中配置 `ADMIN_ENTRY_PATH=/admin-<足够长的随机值>`；路径必须以 `/` 开头，后接 16–128 位字母、数字、下划线或连字符。可用 `openssl rand -hex 24` 生成随机部分。更换此配置后重启，旧入口和旧入口 Cookie 失效；清空配置会恢复使用数据目录中保存的自动入口。开发环境默认不隐藏，显式设置 `ADMIN_ENTRY_PATH` 时也会启用限制。

请保存入口地址，仅向本人提供；程序请求日志会对入口路径脱敏，反向代理的访问日志也应避免记录该路径。该机制隐藏的是后台访问入口，支付链接中的业务域名仍然需要对付款人可见。反向代理应把所有请求转发给应用，避免单独绕过应用提供后台 HTML。

## GitHub Actions 构建 GHCR 镜像

`.github/workflows/docker.yml` 使用现有 Dockerfile 自动构建 `linux/amd64` 和 `linux/arm64` 镜像：

- 推送至 `main` / `master` 时发布分支及提交标签，默认分支额外发布 `latest`。
- 推送 `v*` 标签（例如 `v1.2.3`）时发布版本、次版本及提交标签。
- 支持在 Actions 页面手动运行；PR 只构建验证，不登录仓库、不推送镜像。
- 使用仓库自带的 `GITHUB_TOKEN` 和 `packages: write` 权限，无需额外配置 PAT；Action 固定到提交 SHA，并启用构建缓存。

镜像地址为 `ghcr.io/<owner>/<repository>`，名称自动转为小写。首次发布后，如需匿名拉取，请在 GitHub Packages 中将包设为 Public；私有包需要先执行 `docker login ghcr.io`。若组织限制 Actions 或 Packages 写入，需要在仓库/组织设置中放行相应权限。

在 `.env` 中设置镜像地址，例如当前仓库：

```dotenv
PUBLIC_BASE_URL=https://pay.example.com
ALIMPAY_IMAGE=ghcr.io/woopencri/alimpay:latest
```

然后拉取并启动，无需在服务器编译：

```bash
docker compose pull
docker compose up -d --no-build
```

`data` 挂载保持不变，升级保留订单、配置、主密钥及自动生成的管理入口。

## 收银台金额和客服提示

收银台标题和浏览器标签显示“支付宝安全收银台”，并使用本地支付宝 SVG 图标。经营码订单从原金额开始分配，例如原价 1.00 元的并发订单依次为 1.00、1.01、1.02 元。金额占用按实际支付金额全局去重，并保留至订单创建后第十分钟，避免不同原价订单和迟到支付串单。

发生加分时，页面用醒目提示强调“请务必按精确金额 ¥X.XX 付款”，提醒不要少付、多付或取整。后台“收款配置 → 收银台客服提示”可自定义客服邮箱、联系方式和查询要求，支持换行，最多 2000 字；清空则隐藏。保存后立即作用于收银台和支付结果页面，按纯文本展示。

客服提示默认为空，收银台不显示提示；在后台填写并保存后才展示。例如可填写：如遇到充值问题，可以联系客服邮箱：lin@linapi.net，充值问题记得带上订单号以便查询。

## 首次配置顺序

1. 先通过隐藏管理入口打开后台，再设置 `admin` 的管理员密码和公开根地址。
2. 在“密钥中心”生成支付宝应用 RSA 密钥。
3. 在密钥中心复制已经去掉 PEM 头尾和换行的“应用公钥（支付宝上传格式）”，填写到支付宝开放平台，妥善备份应用私钥。
4. 在“收款配置”填写支付宝应用 ID 和“支付宝公钥”。注意它不是应用公钥。
5. 确认应用具备账务明细查询权限，并在后台执行连接测试。
6. 上传支付宝经营码；如必须使用转账模式，填写收款方支付宝用户 ID。
7. V1 直接复制 PID/key；V2 生成商户密钥对，商户私钥只展示一次，平台只保存商户公钥。

支付宝参考：

- [应用私钥生成说明](https://opendocs.alipay.com/common/055l5k)
- [密钥相关说明](https://opendocs.alipay.com/common/02kf5p.md)
- [V3 账务明细查询](https://opendocs.alipay.com/open-v3/26ed84be_alipay.data.bill.accountlog.query)

## 易支付接口

只接受 `type=alipay`。

### V1 MD5

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/submit.php` | 页面跳转支付 |
| POST | `/mapi.php` | API 下单 |
| GET/POST | `/api.php?act=query` | 商户信息 |
| GET/POST | `/api.php?act=order` | 单笔订单查询 |
| GET/POST | `/api.php?act=orders` | 订单列表 |

签名时排除空值、数组、`sign`、`sign_type`，按参数名 ASCII 升序连接为 `key=value&key=value`，直接追加 V1 key 后计算小写 MD5。

V1 查询接口必须同时提供 PID 和 key；不存在旧版本那种无需密钥的前端查询入口。

### V2 RSA

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/api/pay/submit` | 页面跳转支付 |
| POST | `/api/pay/create` | 统一下单 |
| POST | `/api/pay/query` | 订单查询 |
| POST | `/api/merchant/info` | 商户信息 |
| POST | `/api/merchant/orders` | 订单列表 |

V2 使用 SHA256WithRSA（PKCS#1 v1.5），请求由商户私钥签名，响应与支付通知由平台私钥签名。`timestamp` 是 10 位秒级时间戳，允许与服务器时间相差 300 秒。

密钥中心以不带 PEM 头尾和换行的单行 Base64 显示生成的 RSA 私钥与公钥。V2 商户公钥和支付宝应用私钥导入同时兼容单行 Base64 与完整 PEM。

具体实例地址、PID 和签名说明可在后台“API 文档”查看。

## 通知语义

- `notify_url` 与 `return_url` 只接受 HTTP/HTTPS，禁止 URL 内嵌用户名或密码。
- 默认拒绝本机、私网、链路本地和保留地址；通知前会重新解析 DNS，并禁止跳转。
- 仅当响应为 2xx 且正文去除首尾空白后严格等于 `success` 才确认成功。
- 自动通知最多 10 次：第 1 次立即发送，之后固定每 60 秒一次。
- 后台“补发通知”创建一个独立的一次性任务，不会重置原任务的尝试次数。
- 如确实要向私网测试服务器回调，可设置 `ALLOW_PRIVATE_CALLBACKS=true`；不要在普通生产部署启用。

## 安全与数据

- 管理会话使用 Secure（生产）、HttpOnly、SameSite=Strict Cookie。
- 后台写操作同时校验 CSRF token 和请求 Origin。
- 应用私钥、V1 key、V2 平台私钥使用 `APP_MASTER_KEY` 经 AES-256-GCM 加密后写入数据库。
- V2 商户私钥不落库；生成时只返回一次。
- 金额始终以整数分存储，不使用浮点数做匹配。
- `(pid, out_trade_no)`、支付宝 `account_log_id` 和活动金额预留均有数据库唯一约束。
- 回调响应、日志和审计不会记录明文密钥。

`TRUST_PROXY=true` 只应在应用前方确有可信反向代理时开启，否则不要信任客户端提交的转发 IP 头。

## 备份与恢复

持久数据都在 `DATA_DIR`（Docker 中为 `/data`）：

- `alimpay.sqlite`、`alimpay.sqlite-wal`、`alimpay.sqlite-shm`
- `uploads/` 经营码图片
- 自动生成的 `.master-key`（如显式设置 `APP_MASTER_KEY`，则另行备份环境变量）

在线备份优先使用 SQLite backup：

```bash
sqlite3 data/alimpay.sqlite ".backup 'alimpay-$(date +%F).sqlite'"
```

恢复时先停止 Bun 进程，再恢复数据库、上传目录和与之匹配的 `.master-key`；如使用环境变量，则恢复相同的 `APP_MASTER_KEY`。主密钥不匹配时，所有加密私钥都无法解密。

## 测试

```bash
bun run typecheck
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e
```

单元与契约测试覆盖 V1/V2 签名、订单幂等、金额分配、5/10 分钟状态机、账务流水去重、共享扫描、通知十次重试、会话与 CSRF、SSRF，以及桌面首次配置和移动端页面。

## 扫账超时与自动恢复

单页支付宝账务查询设置 10 秒应用层截止时间，整次分页扫描最多 60 秒。超过时限会取消当前 HTTP 请求、记录失败原因并释放共享扫描任务；下一次调度会按后台配置的轮询间隔自动重试。超时请求即使稍后返回，也不会再匹配订单或修改新扫描的状态。

支付宝 SDK 固定为 `4.14.0`，通过 `patches/alipay-sdk@4.14.0.patch` 为 V3 请求补充 `AbortSignal` 传递，保留官方请求签名和响应验签。`bun install --frozen-lockfile` 会自动应用补丁；Docker 构建及运行阶段均会复制补丁后安装。升级 SDK 时需要重新核对这项补丁。

服务重启后，会把上一个进程遗留的 `running` 扫描标为 `error`，错误原因为 `SCAN_INTERRUPTED`。已完成的扫描、订单和金额占用不会因此修改。后台“系统状态 → 最近扫描”会展示错误原因；连接测试也使用同一套查询超时保护。

这项恢复保护只作用于仍在监控期内的订单。已经超过创建后 10 分钟的历史订单不会自动补识别，须核对实际到账记录后处理。

## 健康检查

- `GET /healthz`：进程存活
- `GET /readyz`：数据库可用，并额外返回 `gateway_ready` 表示收款配置是否完整

时间统一以 UTC 存库；支付宝请求按 Asia/Shanghai 格式化；后台按 Asia/Taipei 展示。
