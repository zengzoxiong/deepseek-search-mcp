# DeepSeek Search MCP

基于 [MCP 官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)（`@modelcontextprotocol/server`）构建的 MCP（Model Context Protocol）server，把 [DeepSeek 官方 Search / Fetch API](https://api-docs.deepseek.com/zh-cn/api/search)（自研搜索引擎）封装为标准 MCP 工具，供 Claude Code / Codex / ZCode / Deepseek Harness 等任意支持 MCP 的客户端使用。

- **官方 SDK 构建**：协议层零手写，兼容性有保障；Node 18+，仅 2 个运行时依赖
- **`webSearch`**：联网搜索（`query` / `count` / `freshness`），输出 `details: Title/Meta/Content/URL` 列表，同时以 `structuredContent` 透传原始结构化数据
- **`webFetch`**：抓取单个网页，返回 Markdown 标题与正文
- **结构化元数据**：每条结果附带发布日期、权威度（`authority` 0-4）、相关性分（`rerank_score` 0-3，≥1.5 为优质）

## 工具说明

#### `webSearch(query, count?, freshness?, ori_question?, localization?, need_content?)`

| 参数           | 说明                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`        | 必填，≤128 字符。支持 `site:` / `-site:` / `lang:` / `after:` / `before:` / `"精确短语"` / `-排除词` 操作符（工具描述内嵌完整语法表）                                   |
| `count`        | 返回条数，1-50，默认 10                                                                                                                                                 |
| `freshness`    | 时效过滤：`pd`(24h) / `pw`(7天) / `pm`(31天) / `py`(365天) 或 `YYYY-MM-DDtoYYYY-MM-DD`，自动翻译为 `after:`/`before:` 操作符；拼接后超 128 字符时自动降级并在结果中提示 |
| `ori_question` | 可选，触发搜索的用户原始问题（官方字段，辅助意图理解）                                                                                                                  |
| `localization` | 可选，用于优先返回本地化结果的 IP 地址（官方字段）                                                                                                                      |
| `need_content` | 是否返回页面全文，默认 `false` 只返回摘要                                                                                                                               |

输出示例：

```
Input：
webSearch("DeepSeek Search API 上线", count=3, freshness="pw")

Output：
details: 共 3 条结果, 耗时 0.34s
Title: Change Log | DeepSeek API Docs
Meta: 发布于 2026-10-16 | 站点=DeepSeek | 权威度=3/4 | 相关性=2.61
Content: Improved Chinese Search Capabilities
URL: https://api-docs.deepseek.com/updates

Title: DeepSeek新版本上线
Meta: 发布于 2026-10-16 | 站点=jingjiribao.cn | 权威度=4/4 | 相关性=2.34
Content: # DeepSeek新版本上线
…（长摘要，此处截略）
URL: http://www.jingjiribao.cn/static/detail.jsp?id=690604

Title: DeepSeek上线搜索抓取API，V4.1快照短暂出现
Meta: 发布于 2026-10-16 | 站点=驱动中国 | 权威度=3/4 | 相关性=2.33
Content: # DeepSeek上线搜索抓取API，V4.1快照短暂出现
…（长摘要，此处截略）
URL: https://app.qudong.com/article/526406.html
```

#### `webFetch(url)`

抓取 `http/https` 网页（≤8192 字符），返回 Markdown 正文（超过 60000 字符自动截断保护）。

输出示例：

```
Input：
webFetch("https://example.com/")

Output:
已抓取 0.47s | Example Domain

该域名仅用于文档示例，无需获得许可。这并非一项服务，请勿将其用于测试和监控目的。

This domain is for use in documentation examples without needing permission\. This is not a service\; avoid relying on it for testing and monitoring purposes\.
…（多语言正文，此处截略）
```

## 开始

首先在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 申请 API Key。

### Linux / macOS 

在 MCP 客户端配置中加入：

```json
{
  "mcpServers": {
    "DeepSeek_Search": {
      "command": "npx",
      "args": ["-y", "deepseek-websearch-mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "你的API Key"
      }
    }
  }
}
```

### Windows

Windows 首先进行全局安装：

```shell
npm install -g deepseek-websearch-mcp
```

再在 MCP 客户端配置中加入：

```json
{
  "mcpServers": {
    "DeepSeek_Search": {
      "command": "cmd",
      "args": ["/c", "deepseek-websearch-mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "你的API Key"
      }
    }
  }
}
```


## 计费与限流

- Search / Fetch 定价以[官方文档](https://api-docs.deepseek.com/zh-cn/guides/search)为准；失败、空结果、超时**不计费**，结果条数不影响单价
- 每账号 Search / Fetch 各限 **5 QPS**（独立计数），Fetch 另有按域名限流，超限返回 429
- 本 server 对 401（Key 无效）/ 402（余额不足）/ 403（安全策略）/ 404（无内容）/ 429（限流）返回中文错误说明，便于 Agent 自行判断是否重试

## 注意事项

- 本项目为**非官方**社区实现，与 DeepSeek 无关联；API 行为以[官方文档](https://api-docs.deepseek.com/zh-cn/api/search)为准
- 调用产生费用由使用者自行承担
- 请勿将 API Key 提交进任何仓库；本 server 仅通过环境变量 `DEEPSEEK_API_KEY` 读取密钥

## License

[MIT](LICENSE)
