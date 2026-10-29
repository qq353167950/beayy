# 部署到 Cloudflare（Workers + R2 + D1）

服务端有两套实现，**接口相同**，客户端只认地址：

| | Docker（`server/`） | Cloudflare（`sync-server/`） |
|---|---|---|
| 技术栈 | FastAPI + SQLite + 本地文件 | Workers + D1 + R2 |
| 运维 | 自己有台机器/VPS | 无需运维，按量付费 |
| 录音转写（ASR） | ✅ 有（`--profile asr`） | ❌ 没有 |
| 存储 | 磁盘 | R2 |
| 适合 | 要用录音转写、或者想完全自己掌控 | 只要「多设备同步 + 账号」 |

**结论**：只用同步 → Cloudflare 足够。要用手表录音转写 → 必须 Docker 或另配转写服务。

---

## 一、准备

```bash
npm i -g wrangler          # 或 npx wrangler
wrangler login             # 浏览器登录 Cloudflare
```

需要 Cloudflare 账号，且**已绑定一个域名**（自定义域名要走这个域名；不绑就用 `*.workers.dev`）。

---

## 二、建资源（★ 必须换成你自己的 ID）

仓库里的 [`wrangler.jsonc`](../sync-server/wrangler.jsonc) 带的 `database_id` **是原作者的**，直接部署会失败或写到别人账号上。先自己建：

```bash
cd sync-server

# 1. D1 数据库（存账号、块的索引）
wrangler d1 create beayy-sync
#   → 输出里有 database_id，类似 589ef894-add4-....
#   → 把 wrangler.jsonc 里 d1_databases[0].database_id 改成这个

# 2. R2 桶（存所有密文块）
wrangler r2 bucket create beayy-sync

# 3. 建表
wrangler d1 execute beayy-sync --remote --file=schema.sql
wrangler d1 execute beayy-sync --remote --file=migrate_v2.sql
wrangler d1 execute beayy-sync --remote --file=migrate_v3.sql
wrangler d1 execute beayy-sync --remote --file=migrate_v4.sql
wrangler d1 execute beayy-sync --remote --file=migrate_v5.sql
wrangler d1 execute beayy-sync --remote --file=migrate_v6.sql
```

**改成你自己的域名**：`wrangler.jsonc` 里

```jsonc
"routes": [{ "pattern": "sync.example.com", "custom_domain": true }]
```

换成你的；不想挂域名就删掉 `routes`，并把 `workers_dev` 改成 `true`（然后用 `xxx.workers.dev`）。

---

## 三、配密钥

```bash
# 注册邀请码：不设就谁也不能注册
wrangler secret put INVITE

# 转写/地图票据的签名密钥（自己生成：openssl rand -hex 32）
wrangler secret put TICKET_SECRET
```

可选（要「官方服务」才有用，自己用不上就跳过）：

```bash
wrangler secret put LLM_KEY        # 官方模型代理的真密钥
wrangler secret put LLM_GATEWAY    # 如 https://api.openai.com/v1
wrangler secret put LLM_MODEL
wrangler secret put AMAP_KEY       # 高德 Web 服务 Key
wrangler secret put AMAP_JS_KEY
wrangler secret put AMAP_JS_CODE
```

---

## 四、部署

```bash
cd sync-server
wrangler deploy
```

第一次要 `-t` 指定账号时：

```bash
CLOUDFLARE_API_TOKEN=<你的 token> wrangler deploy
```

---

## 五、验证

```bash
# 健康检查（server.py 那个，Workers 版也有）
curl -s https://你的域名/v2/health

# 注册一个账号（要带邀请码）
curl -s -X POST https://你的域名/v2/register \
  -H 'content-type: application/json' \
  -d '{"invite":"你设的邀请码","email":"you@example.com",
       "salt":"00112233445566778899aabbccddeeff","auth":"<64位hex>",
       "wrapped_key":"<base64>","recovery":"<64位hex>"}'
```

正常会返回 `{"user":"...","token":"...","session":"..."}`。

**更省事的验证**：在客户端「设置 → 连接 → 同步服务器」填你的地址，然后注册／登录。能登录就说明通了。

---

## 六、客户端怎么指过来

1. 打开 Beayy → 设置 → 连接 → 同步服务器
2. 填 `https://你的域名`（**末尾不要带 `/`**）
3. 保存后去「账号」注册或登录

注册需要你的邀请码（就是第三步设的 `INVITE`）。

---

## 七、账单要留意的三处

| 项 | 免费额度 | 说明 |
|---|---|---|
| **R2 存储** | 10 GB | 每 10 分钟一个分段文件，一个月约 1300 个块/设备；压缩+加密后通常几十 KB/块 |
| **R2 Class A**（写） | 100 万次/月 | **首次同步几千个块会一次性写**，注意别在免费额度边缘反复重装 |
| **D1 读取** | 500 万行/月 | `/v1/list` 每次同步查一次索引，正常用不会超 |

省额度：
- 不要频繁「换账号重登」（每换一次会把 `st.up` 清空、全量重传）
- 首次同步完就稳定了，之后每轮只传变了的分段
- 录音块（`audio.`）30 天自动删，别指望它当长期存储

---

## 八、Cloudflare 版没有的东西

| 缺失 | 影响 | 怎么办 |
|---|---|---|
| **ASR 转写** | 手表录音传上去没人转写 | 用 Docker 版跑 `--profile asr`，或者另找 OpenAI Whisper 类服务 |
| 本地文件落盘 | 无 | 块都在 R2 |

转写服务的地址在客户端「设置 → 连接 → 转写服务」里配，和同步服务器可以分开——**同步走 Cloudflare、转写走自己的 Docker** 是可行的组合。

---

## 九、迁移到自己的账号（如果之前用的是别人的 deck）

如果你之前连的是 `sync.beayy.com` 或别人的实例，换到自己实例时：

1. 新实例注册（**会生成新的数据密钥**）
2. 旧数据不会自动过来——原因是端到端加密，**旧密钥只在你旧设备上**

想在两台服务器之间搬数据，两条路：

- **保数据**：旧设备保持登录 → 导出恢复码 → 新实例登录时用同一把密钥（当前客户端不支持指定密钥，需要手工改）
- **不保**：新 instance 重新开始，旧数据留在旧服务器上

> 这条是设计使然，不是 bug：服务器读不到内容，也就没法替你搬。

---

## 十、常见问题

**`database_id` 没改，部署报 `not authorized`**
→ 第二节第一步，自己 `wrangler d1 create` 换掉。

**注册返回「邀请码不对」**
→ `wrangler secret put INVITE` 之后要重新 `wrangler deploy` 才生效？不需要，secret 立即生效；但要**和你客户端里填的一致**。

**同步一直 401**
→ 客户端的 `need_login` 会显示。通常是令牌被别的设备用恢复码重设时清掉了，重新在客户端登录一次。

**想换域名**
→ 改 `routes` 后重新 `deploy`；客户端里也要把服务器地址改掉（**登录状态下不能改**，先退出）。

**R2 账单超了**
→ 先看 `wrangler r2 bucket list` 和 Cloudflare 面板的用量。大头通常是 `audio.*` 录音块，确认 cron 清理在跑（`wrangler.jsonc` 里有 `17 3 * * *`）。
