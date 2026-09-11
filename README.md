# Content Radar · 内容雷达

自研的**多源内容聚合 + 关键词/AI 过滤**信息流工具，对标截图里 Mirror-Sorter 的使用形态：
左侧设置、中间卡片流、右侧数据源统计与 AI 对话。

零运行时依赖（只用 Node 内置模块），数据全部落在本机。

---

## 功能对照

| Mirror-Sorter 里的功能 | 本项目 | 说明 |
| --- | --- | --- |
| B站内容抓取 | ✅ 原生适配器 | 关键词搜索 / 排行榜 / 热门 / UP 主投稿 / **关注动态** |
| 贴吧内容抓取 | ✅ 原生适配器 | wap 版页面解析，无需登录；支持填自己的 Cookie |
| 小黑盒内容抓取 | ✅ 原生适配器 | Playwright 抄一次接口签名后走纯 HTTP；首抓约 2s，之后 300ms |
| 用自己的账号 | ✅ | B站 / 贴吧 / 小黑盒 均可填 Cookie，一键检测登录态 |
| 关键词搜索 + 严格匹配 | ✅ | 顶栏搜索框 + 「严格」开关（只匹配标题） |
| 关键词筛选规则 | ✅ | 关注词 / `+` 必须词 / `!` 排除词 |
| AI 过滤器剔除 | ✅ | OpenAI 兼容协议，按兴趣描述打分，低于阈值剔除 |
| **AI 摘要** | ✅ | 卡片上点 ✨ 按需生成，结果缓存并计入成本 |
| **每日简报** | ✅ | 一键生成综述 + 条目清单，落盘 Markdown/JSON |
| AI 调用次数 / 成本统计 | ✅ | 右侧面板实时显示，按 token 估算 |
| 卡片信息流（1/2/3/4 栏） | ✅ | 封面、标题、作者、播放/弹幕/点赞、简介、AI 分数与理由 |
| **内嵌播放 + 悬停放大** | ✅ | B站视频卡片内直接播；悬停封面可放大 1.15×~2× |
| 收藏 / 历史 / 信息池 | ✅ | 收藏、已读、已过滤视图、清空信息池 |
| 内嵌 AI 对话 | ✅ | 右侧「新对话」面板，会带上当前信息池上下文 |
| 主题 / 强调色 / 栏数 / 卡片大小 | ✅ | 黑夜/白天、8 色强调色、单/双/三/四栏、4 档卡片尺寸 |
| 定时自动抓取 | ✅ | 设置里填间隔分钟数 |

---

## 快速开始

```bash
# 方式一：桌面 App（推荐）—— 双击 release/ContentRadar/ContentRadar.exe
#          免安装、无需 Node，整个文件夹可以直接拷给别人

# 方式二：开发模式跑 Electron
npm install          # 首次需要，会下载 Electron 运行时（约 235MB）
npm run app

# 方式三：纯网页模式
node src/server.js
start.cmd            # 或双击它，会用 Edge 应用模式打开
```

打开 <http://127.0.0.1:7788>，点右上角 **立即抓取**。

> 端口被占用时会自动 +1，控制台会打印实际地址。

### 打包成免安装 App

```bash
node tools/pack.js
```

产物在 `release/ContentRadar/`，双击 `ContentRadar.exe` 即可运行（约 367MB，主要来自 Electron 运行时）。
脚本直接复用 Electron 的 dist 目录，不需要 electron-builder，也不会联网下载额外工具。

> App 模式的数据（配置 + 内容池）存在 `%APPDATA%\content-radar\data`，
> 和网页模式的 `项目目录/data` 相互独立。

---

## 用自己的账号（可选）

**不填 Cookie 也能用**（匿名抓公开内容）；填了之后会带上登录态，能拿到更完整的内容。

### 两种登录方式

| 方式 | 适用平台 | 说明 |
| --- | --- | --- |
| **扫码登录** | B站 | 点「扫码登录」→ 用 B站 App 扫码 → 自动写入 Cookie（走官方扫码接口） |
| **打开登录窗口** | 贴吧 / 小黑盒 | 点按钮后会弹出一个浏览器窗口，正常登录即可，登录成功后自动抓取 Cookie |
| **手动粘贴** | 全部 | 在输入框里粘贴 Cookie，点「检测登录」验证 |

也可以用「检测登录」验证已有 Cookie 是否有效。

### 手动获取 Cookie

| 平台 | 关键字段 | 怎么获取 |
| --- | --- | --- |
| B站 | `SESSDATA`（建议连 `bili_jct`、`DedeUserID` 一起） | 登录 bilibili.com → F12 → Application → Cookies → 复制整条 Cookie |
| 贴吧 | `BDUSS` | 登录 tieba.baidu.com → 同上 |
| 小黑盒 | `pkey` / `x_xhh_tokenid` | 登录 xiaoheihe.cn → 同上 |

检测结果会显示「已登录：昵称」或「未登录（Cookie 无效或已过期）」。
填了账号后，B站的请求会带登录态，贴吧会读登录可见内容，小黑盒会以你的身份拉推荐流。

> Cookie 明文存在本地 `config.json`，只在本机使用；过期后重新登录一次即可。
> 数据源里也可以单独填 `cookie`（源级配置优先于全局账号）。
>
> 说明：小黑盒网页端没有开放扫码接口（实测 `/account/login/qrcode` 返回「请升级至最新版本」），
> 所以只能走登录窗口；贴吧虽然有百度扫码接口，但换取 Cookie 的流程不稳定，也统一走登录窗口。

---

## 数据源

### B站（原生，开箱即用）

在左侧「数据源」里配置，`mode` 五种模式：

| 模式 | 需要的参数 | 说明 |
| --- | --- | --- |
| `search` | `keyword` | 关键词搜索全站视频 |
| `ranking` | `rid` | 排行榜，`0` = 全站 |
| `popular` | — | 热门推荐 |
| `user` | `mid` | UP 主投稿，`mid` 是主页 URL 里的数字 ID |
| `following` | — | **关注 UP 主动态**，视频与图文动态都支持；需要登录（填 SESSDATA） |

接口调用自带 WBI 签名（`src/sources/bilibili.js` 里实现），并自动获取 `buvid3` 会话，
30 分钟内复用；填了账号后所有请求都会带上登录态。

> `following` 模式调用的是 `/x/polymer/web-dynamic/v1/feed/all`，未登录会返回
> 「需要登录」的明确提示，不会静默失败。

### 贴吧（原生）

`type` 选 `tieba`，填 `kw`（吧名，如 `理论物理`）即可。

- 走贴吧 wap 版页面（`tieba.baidu.com/mo/q/m`），无需登录就能读到吧内帖子列表；
- 自动获取 `BAIDUID` 匿名 Cookie（百度对无 Cookie 请求直接 403）；
- 想更稳定、或想读需要登录的内容，可以把浏览器里的 Cookie 填进 `cookie` 字段（含 `BDUSS`）；
- 抓到的字段：标题、作者、发帖时间、回复数、点赞数，置顶帖会自动跳过。

### 小黑盒（原生）

`type` 选 `xiaoheihe`，`mode` 选 `feed`（社区推荐流）。

- 小黑盒接口要求 `hkey` / `_time` / `nonce` 三个签名参数，算法在前端 JS 里且经常变，
  所以这里**不逆向算法**：用 Playwright 打开一次社区页，从网络请求里抄下已签名的 URL，
  之后复用这个签名走纯 HTTP（实测签名可长期复用，二次抓取 300ms 级）；
- 签名失效会自动回退到浏览器重新获取；
- 依赖 `playwright-core`（不含浏览器内核，用你系统已装的 Edge 或 Chrome，无需额外下载几百 MB）；
- 浏览器实例会复用，闲置 3 分钟自动关闭。

> 贴吧和小黑盒抓的都是「公开可见」的内容，不需要账号也能用；填自己的 Cookie 只是为了更稳定。

### RSS（通用兜底）

`type` 选 `rss`，填 `url` 即可。配合 [RSSHub](https://github.com/DIYgod/RSSHub) 可以接入
微博、知乎、公众号等没有开放接口的站点，例如：

```
https://rsshub.app/weibo/keyword/人工智能
https://rsshub.app/zhihu/hotlist
```

---

## 关键词语法

在左侧「关键词筛选」里填写，逗号或换行分隔：

| 写法 | 含义 |
| --- | --- |
| `人工智能` | 关注词：命中**任一**即通过 |
| `+发布` | 必须词：**全部**必须命中 |
| `!广告` | 排除词：命中**任一**即剔除，优先级最高 |
| 严格匹配开关 | 打开时只看标题；关闭时标题 + 简介 + 作者一起匹配 |

三个列表都留空 = 不设关键词门槛，全部保留。

改完规则点「重新过滤全部」，会对信息池里已有的内容重跑一遍（清空规则后，之前被关键词剔除的条目会放回）。

---

## AI 过滤

在左侧「AI 配置」里填：

- **API 地址**：默认 `https://api.deepseek.com/v1`，任何 OpenAI 兼容接口都行
- **API Key**：`sk-...`
- **模型**：`deepseek-chat` 等
- **兴趣描述**：用自然语言写，例如「我想看 AI 前沿、具身智能、机器人相关的技术内容，不要娱乐八卦」
- **最低保留分数**：0–10，低于该分数被剔除（默认 6）

点「测试连接」验证；之后每次抓取，只对**新条目**调用 AI 打分，不会重复花钱。
右侧面板会显示调用次数、剔除条数和估算成本（单价可在 `data/config.json` 的 `ai.priceIn/priceOut` 调整，单位：元/百万 token）。

没填 Key 时，AI 过滤自动跳过，只走关键词规则。

---

## 目录结构

```
content-radar/
├── start.cmd                  # Windows 一键启动
├── package.json
├── public/                    # 前端（原生 HTML/CSS/JS，无框架）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/
│   ├── server.js              # HTTP 服务 + API + 图片代理
│   ├── config.js              # 配置读写（data/config.json）
│   ├── store.js               # JSON 持久化 + 查询
│   ├── http.js                # 出网封装（超时/重试/UA）
│   ├── pipeline.js            # 抓取 → 过滤 → 入库
│   ├── ai.js                  # AI 客户端 + 成本统计
│   ├── security.js            # 安全防护（SSRF / Host / Origin 校验）
│   ├── filter/keyword.js      # 关键词规则引擎
│   └── sources/
│       ├── index.js           # 适配器注册表
│       ├── bilibili.js        # B站适配器（WBI 签名）
│       ├── tieba.js           # 贴吧适配器（wap 版解析）
│       ├── xiaoheihe.js       # 小黑盒适配器（签名复用）
│       └── rss.js             # RSS/Atom 适配器
├── test/
│   ├── core.test.js           # 单元测试（不触网）
│   ├── ai.test.js             # AI 链路测试（本地 mock 服务）
│   ├── config.test.js         # 配置读写与升级迁移
│   ├── security.test.js       # 安全回归（SSRF / CSRF / 穿越）
│   ├── xss.test.js            # XSS 防护（真实浏览器）
│   ├── audit.test.js          # 依赖漏洞审计
│   ├── ui.test.js             # 布局 UI（真实浏览器）
│   ├── sources.test.js        # 数据源真实抓取
│   ├── pack.test.js           # 打包冒烟
│   └── e2e.test.js            # 端到端（真实抓取，需联网）
└── data/                      # 运行时数据（已 gitignore）
    ├── config.json
    └── db.json
```

---

## 测试

```bash
npm test                      # 单元测试（core / ai / config）
npm run test:ui               # 布局 UI 测试（真实浏览器）
npm run test:live             # 数据源真实抓取（贴吧 / 小黑盒）
npm run test:e2e              # 端到端，会真实访问 B站
node --test test/security.test.js   # 安全回归（SSRF / CSRF / 路径穿越 / 大请求体）
node --test test/xss.test.js        # XSS 防护（真实浏览器注入恶意内容）
node --test test/audit.test.js      # 依赖漏洞审计
```

所有测试都使用独立临时数据目录（`CONTENT_RADAR_DATA_DIR`），不会污染你的真实数据。

---

## 安全说明

这个应用本质是一个**只监听本机的 HTTP 服务**，所以按「本地服务可能被网页或其他进程攻击」的标准做了防护：

| 风险 | 防护措施 |
| --- | --- |
| **SSRF**（图片代理被用来探测内网） | 只允许 `http(s)`；域名会**真实解析**并校验所有解析结果都是公网地址（`127.0.0.1.nip.io` 这类绕过会被拒）；禁止跟随 3xx 跳转；单次最多 8MB；只接受图片类型 |
| **DNS rebinding**（恶意域名解析到 127.0.0.1 后同源读接口） | 校验 `Host` 头必须是 `127.0.0.1` / `localhost` / `::1`，否则一律 403 |
| **CSRF**（恶意网页向本地接口发写请求） | 校验 `Origin` / `Referer` 必须同源，跨站请求一律 403 |
| **路径穿越** | 用 `path.relative` 判断解析后的路径是否仍在 `public/` 内，不依赖字符串前缀 |
| **XSS**（抓来的第三方内容带脚本） | 前端所有第三方字段都经 `esc()` 转义；链接只允许 `http(s)`，`javascript:` / `data:` 会被拦截 |
| **大请求体 / 大响应** | 请求体上限 512KB（超限返回 413），图片代理上限 8MB |
| **Electron 沙箱逃逸** | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`，外链交给系统浏览器打开 |
| **依赖漏洞** | `npm audit` 无 high / critical 漏洞（`node --test test/audit.test.js` 可复验） |

**需要你知道的两点**：

1. **AI API Key、贴吧/小黑盒的 Cookie 是以明文存在本地 `config.json` 里的**（方便直接编辑），`/api/config` 也会原样返回。
   在「只监听本机 + 已校验 Host/Origin」的前提下，远程网页读不到；但同机的其他程序可以。
   如果这个顾虑对你重要，可以把数据目录放到加密盘，或改用系统凭据库。
2. 服务**没有账号体系**，任何能在你电脑上发起 HTTP 请求的程序都能调用它的接口（包括触发抓取、改配置）。
   这是本地工具的正常取舍；请不要把端口映射到公网。

---

## 已知限制

- AI 成本是按 token 估算的，与账单可能有小幅偏差。
- 单机应用，只监听 `127.0.0.1`，没有鉴权，别把端口暴露到公网。
- 图片通过 `/api/proxy` 代理（B站图床有防盗链），该接口禁止访问内网地址。

## 免责声明

仅供个人学习与信息筛选使用。抓取的是各平台公开接口，请勿高频请求或用于商业用途，
并自行遵守目标站点的服务条款。
