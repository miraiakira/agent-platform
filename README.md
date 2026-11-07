# Enterprise Agent Platform

Next.js Web、Go Business API、持久化 Agent Worker 的 pnpm Monorepo。Day 13 新增企业知识、精确 Hybrid RAG 与显式授权记忆；完整说明见 [Day 13](docs/day13-enterprise-knowledge-memory.md)。

## 本地启动

```bash
pnpm install --frozen-lockfile
# 首次初始化的新环境使用 PostgreSQL 17 + pgvector
# 使用你配置的 32 字符以上服务密钥
export BUSINESS_API_KEY='replace-with-a-random-32-plus-character-secret'
docker compose up -d --build postgres business-api
# 用 migration 身份配置 packages/persistence/.env.local 后执行
pnpm --filter @eap/persistence db:migrate
# 受限身份 provision 参见 docs/day9-security-multitenancy.md
pnpm dev
# 另一个终端，配置 services/agent-worker/.env.local
pnpm --filter @eap/agent-worker dev
```

Web 默认 http://localhost:3551；Worker 不包含在根 `pnpm dev` 中。Web 与 Worker 各自配置受限 `DATABASE_URL`，以及现有认证、Checkpoint、Routing 和服务密钥。知识页面为 `/knowledge`；新检索/记忆工具默认禁用，由管理员在组织工具策略中显式启用。记忆写入和删除工具强制 HITL。

Compose 的 PostgreSQL 使用 `infra/postgres/Dockerfile`：基于原 PostgreSQL 17.11 / Alpine 3.24 精确镜像编译 pgvector 0.8.2，保持现有 `postgres_data` 挂载。已有环境先导出数据库及角色备份，再仅更新 postgres 服务并执行迁移。不要执行 `docker compose down -v`，也不要把 Alpine 数据卷直接挂载到 Debian 镜像。CI 与独立测试环境仍可使用全新 `pgvector/pgvector:pg17`。

```bash
# Worker .env.local 提供 Compose 解析所需的 BUSINESS_API_KEY；不会打印密钥
docker compose --env-file services/agent-worker/.env.local build postgres
docker compose --env-file services/agent-worker/.env.local up -d --no-deps postgres
pnpm --filter @eap/persistence db:migrate
```

迁移使用 `MIGRATION_DATABASE_URL`（否则回退 `DATABASE_URL`），必须指向 Worker 实际连接的库；执行用户需具备安装扩展和迁移权限。

## 独立测试

```bash
docker compose -f compose.day13-test.yaml up -d
export TEST_DATABASE_URL='postgresql://eap:eap_day13_test_password@127.0.0.1:5543/eap_test'
# 将其 export 到 shell，或放入 gitignored .env.day13.local
pnpm check
pnpm test:e2e:knowledge
```

`pnpm check` 从 shell 获取 `TEST_DATABASE_URL`；浏览器脚本自动加载可选 `.env.day13.local`，CI 使用环境变量。测试自动创建隔离 Schema 和受限角色，结束时删除，不使用业务 Schema。浏览器默认本机 Chrome；CI 用 `PLAYWRIGHT_CHANNEL=chromium` 和 `pnpm exec playwright install --with-deps chromium`。证据位于 `artifacts/day13-browser/`。

真实 Embedding 使用独立 `EMBEDDING_*` 配置，默认 Mock，不复用 DeepSeek Chat 凭据。CI 不需要付费 API。原有 Day 1–12 测试全部保留。
