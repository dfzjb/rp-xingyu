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
- **角色卡广场**：从可配置的远程索引浏览并一键导入分享卡
- **主题**：深色 / 浅色一键切换

## 开发

```bash
npm install
npm run dev        # http://127.0.0.1:5273
npm run build      # 产物在 dist/，base='./' 支持任意子路径部署
```

## 部署到 GitHub Pages

1. 将本仓库推送到 GitHub（公开仓库可直接使用 Pages）。
2. 仓库 Settings → Pages → Source 选择 **GitHub Actions**，添加工作流：

```yaml
name: Deploy
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/deploy-pages@v4
```

`base: './'` 已配置好，任意子路径（`https://用户名.github.io/仓库名/`）均可直接运行。

## 角色卡广场

广场是一个静态 JSON 清单（默认读取本仓库 `public/plaza/index.json`），格式：

```json
[
  { "name": "卡名", "description": "简介", "tags": ["标签"], "url": "cards/xxx.json" }
]
```

- `url` 指向 SillyTavern v2/v3 卡 JSON 或 PNG（相对 index.json 所在目录或任意绝对地址）
- 在「设置 → 角色卡广场地址」改成你自己的清单地址即可接入任何卡池

## 从旧版迁移

旧版用户可在新站「导入 / 导出」页选择 `legacy_backup_*.json` 一键恢复全部角色卡与聊天记录；
新站导出的备份文件同样可以被旧版导入。

## 测试工具（tools/）

- `mock_legacy_server.py`：本地模拟旧版迁移接口 + 假 OpenAI SSE API（联调用）
- `.browser-regress.mjs`、`sse_test_page.html`：浏览器回归辅助
