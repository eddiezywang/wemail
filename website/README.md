# WeMail 官方文档站

该目录是独立的 Astro 5 + Starlight 静态文档项目。

## 本地开发

```powershell
npm install
npm run dev
```

## 检查与构建

```powershell
npm run test:all
```

构建结果位于 `dist/`。渲染页面按路由输出为 `index.html`，原始 Markdown/MDX 位于 `dist/raw/`。

## 使用 Node 22 运行

```powershell
npm run build
$env:PORT = "4321"
npm start
```

健康检查：`http://127.0.0.1:4321/healthz`

## Docker

从仓库根目录执行：

```powershell
docker build -t wemail-docs website
docker run --rm -p 4321:4321 wemail-docs
```

然后访问 `http://127.0.0.1:4321/`。原始 MCP 文档示例位于 `http://127.0.0.1:4321/raw/features/mcp.mdx`。

运行时镜像只包含 `dist/` 与 `server.mjs`，并使用非 root 的 `node` 用户。
