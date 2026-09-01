# RP · 星屿（rp-site）

本地优先的 AI 角色扮演站点：**所有数据只存在你的浏览器里**，服务器零用户数据。
Vue 3 + TypeScript + Vite + Pinia + Dexie(IndexedDB)，UI 基于 Naive UI + 自定义设计系统。

## 功能一览

- **对话**：SSE 流式、思维链折叠、树式消息（重 roll 生成兄弟分支，历史不丢）、楼层/字数统计、图片附件、旧版 HTML 消息沙箱渲染
- **角色卡**：SillyTavern PNG/JSON 导入导出（v2/v3 兼容）；备选开场白、示例对话、system_prompt / post_history_instructions 覆盖；可视化世界书编辑器与正则脚本编辑器
- **记忆系统**：会话记忆条目 + AI 提炼最近剧情 + 自动巡逻提炼；按旧版语义绑定到 AI 消息后注入
- **好感度**：六维三轴关系模型（兴趣↔厌烦、信任↔尴尬、吸引↔反感，对轴此消彼长）+ 雷达图可视化 + 9 段关系阶段推导，状态行自动注入提示词
- **预设**：内置旧版同款预设条目（防抢话/防神化/防重复等），可自建带角色的提示词条目
- **导入 / 导出**：与旧版同构的 `legacy_backup_*.json` 备份互导；酒馆 JSONL 聊天记录导入；全库完整备份
- **角色卡广场**：从可配置的远程索引浏览并一键导入分享卡；自建广场服务可让用户直接上传自己的卡
- **在线跑团**：多人房间 + AI 主持（KP）+ 表达式骰子；中继端到端加密、零存储，战役只存房主浏览器
- **主题**：深色 / 浅色一键切换

## 开发

```bash
npm install
npm run dev        # http://127.0.0.1:5273
npm run build      # 产物在 dist/，base='./' 支持任意子路径部署
npm run typecheck  # vue-tsc 类型检查
npm test           # Vitest 单元测试（157 项，覆盖引擎层、db 持久化、跑团与广场服务）
```

## CI

仓库内置两个 GitHub Actions 工作流：

- `.github/workflows/ci.yml`：push / PR 时执行类型检查 + 单元测试 + 生产构建
- `.github/workflows/deploy.yml`：main 分支推送时执行上述检查并自动发布 GitHub Pages

## 部署到 GitHub Pages

1. 将本仓库推送到 GitHub（公开仓库可直接使用 Pages）。
2. 仓库 Settings → Pages → Source 选择 **GitHub Actions**。
3. 推送到 main 即自动构建并发布（工作流已在 `.github/workflows/deploy.yml` 内置）。

`base: './'` 已配置好，任意子路径（`https://用户名.github.io/仓库名/`）均可直接运行。

## 角色卡广场

广场是一个静态 JSON 清单（默认读取本仓库 `public/plaza/index.json`），格式：

```json
[
  { "name": "卡名", "description": "简介", "tags": ["标签"], "url": "cards/xxx.json" }
]
```

- `url` 指向 SillyTavern v2/v3 卡 JSON 或 PNG（相对 index.json 所在目录或任意绝对地址）
- 前端默认从站主广场服务拉取清单；在「广场后台 → 广场索引地址」改成你自己的清单地址即可接入任何卡池

### 自建广场：上传 API

想让别人把卡传到你的广场，用仓库内置的广场服务（零依赖，node:http）：

```bash
npm run plaza                    # http://0.0.0.0:8788，托管 <仓库>/public/plaza
PLAZA_PORT=9000 PLAZA_DIR=/data/plaza PLAZA_TOKEN=口令 npm run plaza   # 全部可选
```

- `GET /plaza/index.json`、`GET /plaza/cards/*`：清单与卡片（即前端订阅的静态索引）
- `POST /plaza/api/cards`：上传。请求体 `{ filename, data(base64), name, description, tags }`，服务端校验扩展名/PNG 签名/JSON 合法性与大小（≤6MB），重名自动加序号后写入 `cards/` 并追加进 `index.json`
- `GET /plaza/api/ping`：探活（前端配置完地址可先试一下）
- `POST /plaza/api/cards`：**开放上传，无需口令**。卡进入待审区（`pending/`，不公开、不进清单），前端提示"已提交审核"
- `GET /plaza/api/review`、`GET /plaza/api/review/<id>`：管理口令 → 待审列表 / 取待审卡原文件（审前人工检查）
- `POST /plaza/api/approve` / `POST /plaza/api/reject`：管理口令 → 上架（移入 `cards/` 并写进清单）/ 拒绝删除
- `POST /plaza/api/remove`：管理口令 → 下架已上架卡（上架后发现违规的刹车）
- `PLAZA_TOKEN` 是**管理口令**（审核与下架凭据，与上传无关），**生产必配**——否则陌生人传的卡永远无法上架
- 内容安全三件套：开放上传但先审后上架、每 IP 上传限速（默认 60 次/小时，`PLAZA_RATE_PER_HOUR` 可调）、待审队列上限（默认 200，`PLAZA_MAX_PENDING` 可调）
- 前端「卡片广场」页：**用户零配置**——浏览/导入/开放上传开箱即用（默认地址内置在 `src/db.ts` 的 `DEFAULT_SETTINGS`，指向站主服务器；自部署到其他域名需同步修改）
- 站主从「**更多 → 管理员口令**」进入：输入服务器 `PLAZA_TOKEN` 校验通过即进入**广场后台**（独立页面）——配置索引/上传地址、审核待审卡（通过上架 / 拒绝 / 试卡——先把待审卡导入本地试玩再决定）、已上架卡一键下架；口令只存本机浏览器，侧边栏无任何后台入口
- 前端「上传接口地址」填 `http://<host>:8788/plaza/api/cards`；卡片是公开资源，跨域（CORS）已放开

#### 部署到自有服务器（示例 dfzjb.site）

```bash
# 1. 服务器上取代码 + 装依赖（server 无构建需求）
git clone <本仓库> /opt/rp-site && cd /opt/rp-site && npm ci --omit=dev

# 2. 修改 deploy/plaza.service 里的 PLAZA_TOKEN（必改）与路径，然后装成系统服务
sudo cp deploy/plaza.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now rp-plaza

# 3. 把 deploy/nginx-plaza.conf 的 location /plaza/ 片段粘进 server{}，放宽 body 上限后重载
sudo nginx -t && sudo systemctl reload nginx
```

- 防火墙**不要**放行 8788，只走 nginx 的 443（X-Forwarded-For 是限速与下架审计的来源依据）
- 前端配置：用户无需任何配置（默认地址已内置指向 dfzjb.site）；站主在「更多 → 管理员口令」输入 `PLAZA_TOKEN` 解锁广场后台，即可审核上架/拒绝/下架
- 备份 = 打包 `PLAZA_DIR`（`index.json` + `cards/`）一个目录

## 从旧版迁移

旧版用户可在新站「导入 / 导出」页选择 `legacy_backup_*.json` 一键恢复全部角色卡与聊天记录；
新站导出的备份文件同样可以被旧版导入。

## 在线跑团（server/）

多人在线跑团：AI 担任 KP，玩家各饰一角；房间消息端到端加密（房间码即密钥），中继服务器**零存储、零日志**，战役只存在房主浏览器 IndexedDB。

大厅工具栏「模型」= 跑团**模型设置**：可为 KP 单独配一套 API（只对在线跑团生效，主站对话不受影响）；不配置时自动使用「更多 → 语言模型」的当前模型。中继地址与世界观备注收在该弹窗的「高级」折叠区。

工具栏下方右侧是常驻的「**我的团**」面板：列出你开过的战役（封面/房间码/剧情条数，保存在**本机浏览器 IndexedDB**，退出不丢、服务器零存储），可一键恢复进房（沿用原房间码与密码）或删除；头部「保留 − N ＋」可自选只保留最近 N 场（0 = 全部保留，超出自动清理最旧的）。创建房间弹窗顶部也保留最近 3 场的快捷恢复。「创建房间」始终开**全新战役**，恢复只走面板或弹窗顶部的恢复入口。

创建房间支持**简洁 / 详细**两种模式（弹窗顶部滑块切换，选择记在本机）：

- **简洁**：房间名 + 简介 + 封面 + 上锁密码，够开一桌自由团；
- **详细**：完整开团设定——规则系统（自由团 / COC7th / DND5e / 自定义，含各规则的检定约定与快捷骰）、时代背景、自定义基调标签、人数、KP 风格、世界观与舞台、模组梗概（KP 秘密）、开场场景、开场白（建团后自动作为第一段旁白发到剧情流）、关键 NPC、房规、内容红线（这三项均逐条添加、随意删减）、场景/地图备注。设定只进 KP 提示词与战役存档（E2EE 同步给成员查看），不经过中继；AI 辅助可从一句话构想生成全套设定。

```bash
npm run server     # 中继 ws://127.0.0.1:8787（仅一个依赖：ws）
```

- 开发模式（`npm run dev`）已把 `/ws` 代理到 8787，开箱即用；
- 生产部署时把 `/ws` 反代到中继进程（nginx `proxy_set_header Upgrade`），或在前端设置里填中继地址；
- GitHub Pages 等纯静态托管只包含前端，中继需要自己找台服务器跑。

## 测试工具（tools/）

- `mock_legacy_server.py`：本地模拟旧版迁移接口 + 假 OpenAI SSE API（联调用）
- `.browser-regress.mjs`、`sse_test_page.html`：浏览器回归辅助
