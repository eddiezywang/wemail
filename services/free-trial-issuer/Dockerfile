# 限时免费资源 — 运营签发服务
# 构建：docker build -f services/free-trial-issuer/Dockerfile -t wemail-free-trial-issuer .
# 运行（必填环境变量见 README.md，尤其 WEMAIL_FREE_TRIAL_ADMIN_PASSWORD）：
#   docker run -d --name free-trial-issuer -p 8787:8787 \
#     -e WEMAIL_FREE_TRIAL_ISSUER_KEY=... \
#     -e WEMAIL_FREE_TRIAL_ADMIN_PASSWORD=... \
#     wemail-free-trial-issuer
FROM node:22-alpine
WORKDIR /app
COPY services/free-trial-issuer/server.ts ./server.ts
# 运行时零依赖（纯 node:http + fetch），无需 npm install
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "server.ts"]
