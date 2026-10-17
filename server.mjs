#!/usr/bin/env node
/**
 * DeepSeek Search MCP — DeepSeek 联网搜索的 stdio MCP server
 *
 * 基于 MCP 官方 SDK（@modelcontextprotocol/server）构建，协议层零手写。
 * 底层为官方 Search / Fetch API（https://api-docs.deepseek.com/zh-cn/api/search）：
 *   POST https://api.deepseek.com/v1/tools/search  网页搜索
 *   POST https://api.deepseek.com/v1/tools/fetch   抓取单页转 Markdown
 *
 * 工具:
 *   webSearch(query, count?, freshness?, ori_question?, localization?, need_content?)
 *   webFetch(url)
 *
 * 相对官方接口的两处增强:
 *   1. freshness 便捷参数（pd/pw/pm/py 或 YYYY-MM-DDtoYYYY-MM-DD），自动翻译为
 *      after:/before: 查询操作符；
 *   2. webSearch 结果格式化为 Title/Meta/Content/URL 文本（清洗转义噪声），同时
 *      以 structuredContent 透传原始结构化数据，供程序化消费。
 *
 * 运行: node server.mjs（stdio 传输，Node 18+）
 * 鉴权: 环境变量 DEEPSEEK_API_KEY（必需，在 MCP 注册配置的 env 中填写）
 * 计费: 5 元/千次成功请求（失败/空结果不计费），每账号 Search/Fetch 各 5 QPS
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const API_BASE = "https://api.deepseek.com";
const SEARCH_PATH = "/v1/tools/search";
const FETCH_PATH = "/v1/tools/fetch";
// 快捷时效语义: pd=过去24小时 pw=过去7天 pm=过去31天 py=过去365天
const FRESHNESS_DAYS = { pd: 1, pw: 7, pm: 31, py: 365 };
const QUERY_MAX = 128;        // 官方: query 1~128 个 Unicode 字符
const FETCH_URL_MAX = 8192;   // 官方: fetch url 上限
const FETCH_CONTENT_MAX = 60000; // 超长正文截断保护，避免撑爆模型上下文

const { name, version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
);

/** 把 freshness 快捷参数翻译成 DeepSeek 的 after:/before: 查询操作符 */
function freshnessToOps(freshness) {
  if (!freshness) return "";
  const f = String(freshness).trim().toLowerCase();
  if (f in FRESHNESS_DAYS) {
    const start = new Date(Date.now() - FRESHNESS_DAYS[f] * 86400000);
    return " after:" + start.toISOString().slice(0, 10);
  }
  if (f.includes("to")) {
    const [a, b] = f.split("to", 2).map((s) => s.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) {
      throw new Error(`freshness 日期范围格式无效: ${freshness}，应为 pd/pw/pm/py 或 YYYY-MM-DDtoYYYY-MM-DD`);
    }
    return " after:" + a + (b ? " before:" + b : "");
  }
  throw new Error(`freshness 参数无效: ${freshness}，支持 pd(24h)/pw(7天)/pm(31天)/py(365天) 或 YYYY-MM-DDtoYYYY-MM-DD`);
}

/** 调用 DeepSeek 工具接口，返回 { data, ms }；非 2xx 抛 Error（带中文提示） */
async function apiPost(path, payload) {
  const key = (process.env.DEEPSEEK_API_KEY || "").trim();
  if (!key) {
    throw new Error("未配置 DEEPSEEK_API_KEY 环境变量。请在 MCP 注册配置的 env 中填入 platform.deepseek.com 申请的 API Key。");
  }
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(API_BASE + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new Error("无法连接 DeepSeek API: " + (e?.cause?.code || e?.message || e));
  }
  const body = await resp.text();
  if (!resp.ok) {
    let detail = "";
    try { detail = JSON.parse(body)?.error?.message || ""; } catch { /* 非 JSON 错误体，保留空详情 */ }
    const hints = {
      401: "API Key 无效",
      402: "账户余额不足，请到 platform.deepseek.com 充值",
      403: "请求被安全策略拒绝",
      404: "未获取到可用内容（如网页无法抓取）",
      429: "触发限流（每账号 5 QPS），请稍后重试",
    };
    throw new Error(`DeepSeek API HTTP ${resp.status}: ${hints[resp.status] || ""} ${detail.slice(0, 300)}`.trimEnd());
  }
  return { data: JSON.parse(body), ms: (Date.now() - t0) / 1000 };
}

/** 清理 DeepSeek 长摘要中的转义噪声（\, \/ ） */
const clean = (s) => String(s).replace(/\\,/g, ",").replace(/\\\//g, "/").trim();

/** 把搜索结果格式化为 Title/Meta/Content/URL 文本 */
function formatSearchResults(results, ms, note) {
  const lines = [`details: 共 ${results.length} 条结果, 耗时 ${ms.toFixed(2)}s${note}`];
  for (const r of results) {
    lines.push("Title: " + (r.title || "(无标题)"));
    const meta = [];
    if (r.date) meta.push("发布于 " + String(r.date).slice(0, 10));
    if (r.site_name) meta.push("站点=" + r.site_name);
    if (r.authority != null && r.authority !== -1) meta.push(`权威度=${r.authority}/4`);
    if (r.rerank_score != null) meta.push(`相关性=${Number(r.rerank_score).toFixed(2)}`);
    if (meta.length) lines.push("Meta: " + meta.join(" | "));
    let body = r.summary || r.snippet || "";
    if (r.content) body = r.content.slice(0, 6000); // need_content 开启时展示正文前段，全量仍在 structuredContent
    lines.push("Content: " + clean(body));
    lines.push("URL: " + r.url);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function toolWebSearch(args) {
  const query = String(args.query ?? "").trim();
  if (!query) return text("query 不能为空。", true);
  if (query.length > QUERY_MAX) {
    return text(`query 超过 DeepSeek 上限 128 字符（当前 ${query.length}），请缩短后重试。`, true);
  }
  const count = args.count ?? 10; // 官方: 1~50，默认 10（schema 已约束）
  const needContent = Boolean(args.need_content);
  const oriQuestion = String(args.ori_question ?? "").trim(); // 官方字段: 用户原始问题，辅助意图理解

  let ops;
  try {
    ops = freshnessToOps(args.freshness);
  } catch (e) {
    return text(e.message, true);
  }

  let fullQuery = query + ops;
  let note = "";
  if (fullQuery.length > QUERY_MAX) {
    // 拼上时间过滤后超长时降级为不加时间过滤，保证搜索仍然可用
    fullQuery = query.slice(0, QUERY_MAX);
    note = "（提示: query 已达 DeepSeek 128 字符上限，freshness 时间过滤本次未生效）";
  }

  const payload = { query: fullQuery, count, need_content: needContent };
  if (oriQuestion && oriQuestion.length <= QUERY_MAX) payload.ori_question = oriQuestion;
  if (args.localization) payload.localization = String(args.localization);

  const { data, ms } = await apiPost(SEARCH_PATH, payload);
  const results = data.results || [];
  if (!results.length) return text("无搜索结果（空结果不计费）。" + note);

  return {
    // 原始结构化数据透传，供支持 structuredContent 的客户端程序化消费
    structuredContent: data,
    content: [{ type: "text", text: formatSearchResults(results, ms, note) }],
  };
}

async function toolWebFetch(args) {
  const url = String(args.url ?? "").trim();
  if (!url) return text("url 不能为空。", true);
  if (url.length > FETCH_URL_MAX) return text("url 超过 DeepSeek 上限 8192 字符。", true);
  if (!/^https?:\/\//.test(url)) return text("url 必须以 http:// 或 https:// 开头。", true);

  const { data, ms } = await apiPost(FETCH_PATH, { url });
  const title = (data.title || "").trim();
  let content = (data.content || "").trim();
  if (!content) return text("页面无可用正文（不计费）。", true);
  if (content.length > FETCH_CONTENT_MAX) {
    content = content.slice(0, FETCH_CONTENT_MAX) + `\n\n…（正文超过 ${FETCH_CONTENT_MAX} 字符已截断）`;
  }
  const header = title ? `已抓取 ${ms.toFixed(2)}s | ${title}\n\n` : `已抓取 ${ms.toFixed(2)}s\n\n`;
  return { content: [{ type: "text", text: header + content }] }; // 正文可能很大，不进 structuredContent 以免双倍载荷
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

const SEARCH_QUERY_DESC = [
  "搜索关键词或短语，必填，≤128 字符。",
  "",
  "| 操作符 | 示例 | 说明 |",
  "| --- | --- | --- |",
  "| `site:` | `DeepSeek site:github.com` | 限定站点；多站点用空格分隔并以 OR 连接 |",
  "| `-site:` | `DeepSeek -site:example.com` | 排除站点 |",
  "| `-词` | `DeepSeek -广告` | 排除含该词的页面 |",
  '| `-"..."` | `DeepSeek -"发布说明"` | 排除精确短语 |',
  '| `"..."` | `DeepSeek "精确短语"` | 精确短语匹配 |',
  "| `lang:` | `DeepSeek lang:zh,en` | 限定语言代码，逗号分隔 |",
  "| `after:` / `before:` | `DeepSeek after:2025-01-01` | 按发布日期过滤；传 freshness 参数可自动生成 |",
].join("\n");

function createServer() {
  const server = new McpServer({ name, version });

  server.registerTool(
    "webSearch",
    {
      description:
        "联网搜索（DeepSeek 自研搜索引擎，多语言，过滤 SEO 作弊与低质内容）。" +
        "返回 Title/Meta(发布日期、权威度、相关性)/Content/URL 列表，" +
        "同时提供 structuredContent 原始数据。计费 5 元/千次成功请求。",
      inputSchema: z.object({
        query: z.string().min(1).describe(SEARCH_QUERY_DESC),
        count: z.number().int().min(1).max(50).optional().describe("返回结果数，1-50，默认 10"),
        freshness: z
          .string()
          .optional()
          .describe(
            "时效过滤，可选。pd=过去24小时 pw=过去7天 pm=过去31天 py=过去365天，或 YYYY-MM-DDtoYYYY-MM-DD；" +
              "自动翻译为 after:/before: 操作符"
          ),
        ori_question: z
          .string()
          .max(128)
          .nullable()
          .optional()
          .describe("触发搜索的用户原始问题，可选，≤128 字符。传入后 DeepSeek 能更好理解搜索意图"),
        localization: z
          .string()
          .optional()
          .describe("用于优先返回本地化搜索结果的 IP 地址，可选。默认为空字符串"),
        need_content: z
          .boolean()
          .optional()
          .describe("是否返回页面全文（content 字段），默认 false 只返回摘要。开启后单条信息量更大"),
      }),
    },
    toolWebSearch
  );

  server.registerTool(
    "webFetch",
    {
      description:
        "抓取单个网页，返回 Markdown 格式的标题与正文（DeepSeek Fetch API）。" +
        "适合搜索命中后读取全文。计费 5 元/千次成功请求。",
      inputSchema: z.object({
        url: z
          .string()
          .describe("要抓取的网页地址，http/https，≤8192 字符，不得包含用户名或密码"),
      }),
    },
    toolWebFetch
  );

  return server;
}

function readConfig() {
  if (!process.env.DEEPSEEK_API_KEY) {
    // 与 SDK 错误口径一致：启动期直接失败并给出中文指引
    throw new Error("未配置 DEEPSEEK_API_KEY 环境变量。请在 MCP 注册配置的 env 中填入 platform.deepseek.com 申请的 API Key。");
  }
}

try {
  readConfig();
  serveStdio(() => createServer());
} catch (error) {
  console.error("[deepseek-search-mcp] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
