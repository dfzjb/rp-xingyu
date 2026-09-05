# 卡片广场服务（server/plaza.js）

广场是一个静态 JSON 清单 + 零依赖 Node 托管服务。前端「卡片广场」页默认从站主广场服务拉取清单；自部署者把地址改成自己的即可接入任何卡池。

## 清单格式

静态清单（示例见 `public/plaza/index.json`）：

```json
[
  { "name": "卡名", "description": "简介", "tags": ["标签"], "url": "cards/xxx.json" }
]
```

- `url` 指向 SillyTavern v2/v3 卡 JSON 或 PNG（相对 index.json 所在目录或任意绝对地址）
- 前端「广场后台 → 广场索引地址」可改成任何清单地址

## 运行

```bash
npm run plaza                    # http://0.0.0.0:8788，托管 <仓库>/public/plaza
PLAZA_PORT=9000 PLAZA_DIR=/data/plaza PLAZA_TOKEN=口令 npm run plaza   # 全部可选
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plaza/index.json`、`/plaza/cards/*` | 清单与卡片（前端订阅的静态索引） |
| POST | `/plaza/api/cards` | **开放上传，无需口令**。请求体 `{ filename, data(base64), name, description, tags }`，服务端校验扩展名/PNG 签名/JSON 合法性与大小（≤6MB），重名自动加序号后写入 `cards/` 并追加进 `index.json` |
| GET | `/plaza/api/ping` | 探活 |
| GET | `/plaza/api/review`、`/plaza/api/review/<id>` | 管理口令 → 待审列表 / 取待审卡原文件（审前人工检查） |
| POST | `/plaza/api/approve`、`/plaza/api/reject` | 管理口令 → 上架 / 拒绝删除 |
| POST | `/plaza/api/remove` | 管理口令 → 下架已上架卡 |

> 注：开放上传的卡进入待审区（`pending/`，不公开、不进清单），前端提示"已提交审核"——**先审后上架**。

## 内容安全

- 开放上传但先审后上架
- 每 IP 上传限速（默认 60 次/小时，`PLAZA_RATE_PER_HOUR` 可调）
- 待审队列上限（默认 200，`PLAZA_MAX_PENDING` 可调）
- `X-Forwarded-For` 由反向代理强制为真实来源（见 nginx 片段），防伪造刷限速

## 站主后台（前端）

- 从「**更多 → 管理员口令**」进入：输入服务器 `PLAZA_TOKEN` 校验通过即进入**广场后台**（独立页面）——配置索引/上传地址、审核待审卡（通过上架 / 拒绝 / 试卡——先把待审卡导入本地试玩再决定）、已上架卡一键下架；口令只存本机浏览器，侧边栏无任何后台入口
- `PLAZA_TOKEN` 是**管理口令**（审核与下架凭据，与上传无关），**生产必配**

## 部署到自有服务器

```bash
# 1. 服务器上取代码 + 装依赖（server 无构建需求）
git clone <本仓库> /opt/rp-site && cd /opt/rp-site && npm ci --omit=dev

# 2. 修改 deploy/plaza.service 里的 PLAZA_TOKEN（必改）与路径，然后装成系统服务
sudo cp deploy/plaza.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now rp-plaza

# 3. 把 deploy/nginx-plaza.conf 的 location /plaza/ 片段粘进 server{}，放宽 body 上限后重载
sudo nginx -t && sudo systemctl reload nginx
```

- 防火墙**不要**放行 8788，只走 nginx 的 443
- 前端默认地址内置在 `src/db.ts` 的 `DEFAULT_SETTINGS`；自部署到其他域名需同步修改
- 备份 = 打包 `PLAZA_DIR`（`index.json` + `cards/` + `pending/`）一个目录
