# Runs the gate as a Streamable HTTP server (for ChatGPT, claude.ai and other
# remote clients). Pass the database MCP server in GATE_COMMAND, the Hibira
# app in HIBIRA_APP_ID / HIBIRA_KEY / HIBIRA_SECRET, and an access token in
# GATE_TOKEN. Example:
#   docker run -p 8787:8787 -e GATE_TOKEN=... -e HIBIRA_APP_ID=... -e HIBIRA_KEY=... -e HIBIRA_SECRET=... \
#     -e GATE_COMMAND='npx -y @bytebase/dbhub --transport stdio --dsn postgres://...' hibira-mcp-approval-gate
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin.js ./
COPY src ./src
ENV GATE_HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
USER node
ENTRYPOINT ["node", "/app/bin.js", "--http"]
