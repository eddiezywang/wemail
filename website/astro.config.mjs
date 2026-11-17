import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: process.env.SITE_URL ?? "http://localhost:4321",
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
  integrations: [
    starlight({
      title: "WeMail 文档",
      description: "WeMail 本地优先智能邮件客户端官方文档",
      logo: {
        src: "./src/assets/wemail-logo.svg",
        alt: "WeMail",
      },
      locales: {
        root: {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      customCss: [
        "./src/styles/custom.css",
        "./src/styles/feature-demos.css",
      ],
      head: [
        {
          tag: "link",
          attrs: { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
        },
      ],
      sidebar: [
        {
          label: "开始使用",
          items: [
            { label: "认识 WeMail", link: "/getting-started/overview/" },
            { label: "安装 WeMail", link: "/getting-started/install/" },
            { label: "连接邮箱", link: "/getting-started/connect-mailbox/" },
            { label: "配置 AI", link: "/getting-started/configure-ai/" },
          ],
        },
        {
          label: "核心功能",
          items: [
            { label: "WeMail AI", link: "/features/ai/" },
            { label: "本地 MCP", link: "/features/mcp/" },
            { label: "Agent 与自动化", link: "/features/agent-automation/" },
          ],
        },
        {
          label: "安全与帮助",
          items: [
            { label: "安全与隐私", link: "/security/privacy/" },
            { label: "故障排查", link: "/help/troubleshooting/" },
            { label: "常见问题", link: "/help/faq/" },
          ],
        },
      ],
    }),
  ],
});
