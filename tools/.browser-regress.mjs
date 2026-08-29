// 浏览器回归脚本：导出下载 + 发送流式（由 node_repl 通过文件导入执行，绕开传输截断）
const bp = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupBrowserRuntime } = await import(pathToFileURL(join(bp, "scripts", "browser-client.mjs")).href);
await setupBrowserRuntime({ globals: globalThis });
const browser = await agent.browsers.getForUrl("http://127.0.0.1:8010/");
const tabs = await browser.tabs.list();
const tab = await browser.tabs.get(tabs[0].id);

async function refs(part) {
  const dom = await tab.dom_cua.get_visible_dom();
  const s = typeof dom === "string" ? dom : JSON.stringify(dom);
  const all = [...s.matchAll(/"ref":"(e\d+)","role":"button","name":"([^"]*)"/g)];
  return all.filter((x) => x[2].includes(part));
}

// 1) 进入数据页
let onImport = false;
for (let i = 0; i < 4 && !onImport; i++) {
  const nav = await refs("导入 / 导出");
  if (nav.length) await tab.dom_cua.click({ node_id: nav[0][1] });
  await tab.playwright.waitForTimeout(800);
  onImport = (await refs("选择备份文件")).length > 0;
}
console.log("onDataView:", onImport);

// 2) 导出 → 等待下载事件
if (onImport) {
  const dlPromise = tab.playwright.waitForEvent("download", { timeoutMs: 9000 }).catch(() => null);
  let clicked = false;
  for (let i = 0; i < 3 && !clicked; i++) {
    const btn = await refs("导出数据");
    if (!btn.length) break;
    try {
      await tab.dom_cua.click({ node_id: btn[btn.length - 1][1] });
      clicked = true;
    } catch (e) {
      await tab.playwright.waitForTimeout(500);
    }
  }
  const dl = await dlPromise;
  await tab.playwright.waitForTimeout(600);
  console.log("exportDownload:", !!dl);
}
console.log("DONE");
