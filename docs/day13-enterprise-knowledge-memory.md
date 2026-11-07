# Day 13 — Enterprise Knowledge, Hybrid RAG & Agent Memory

## Architecture

`packages/knowledge` owns parsing/chunking, embedding abstraction, KnowledgeStore, ingestion and Agent tools. It depends on the existing Persistence security/tenant facade, ToolRegistry and observability. Web exposes protected routes and `/knowledge`; the existing Agent Worker process runs Knowledge ingestion beside Agent Jobs and Evaluation, using the same PostgreSQL lease-token/fencing pattern. No new independent job framework, external cache or unauthenticated storage route is introduced.

## Database Schema / pgvector Setup

Migration `009_knowledge_memory.sql` creates `vector` in `public`, plus knowledge_bases, knowledge_documents, knowledge_document_versions, knowledge_chunks, knowledge_acl, knowledge_groups, knowledge_group_members, agent_memories and retrieval_snapshots. All business tables have FORCE RLS and maintenance-owner policies; composite foreign keys bind children to the same tenant. Versions/chunks/snapshots are immutable after indexing. Content/checksum/embedding dimensions are checked in PostgreSQL.

Compose builds `infra/postgres/Dockerfile`, installing pgvector 0.8.2 on the exact PostgreSQL 17.11 / Alpine 3.24 base used by the existing data volume. Back up database and global roles before updating only the postgres service; its named volume remains unchanged. CI and the independent test database use fresh `pgvector/pgvector:pg17` containers; the latter uses port 5543 and never attaches the existing production volume. Cross-distribution image changes still require backup/restore and collation compatibility rehearsal. Runtime users cannot create extensions. Migration identity alone installs/owns the extension; separate restricted Web/Auth/Worker roles remain in use. Official reference: [pgvector](https://github.com/pgvector/pgvector).

## Ingestion Pipeline

Upload → MIME/UTF-8/magic/size validation → protected PostgreSQL bytea → queued version → parse → Unicode chunk → batch embed → atomic index/Ready. Raw files are at most 2 MiB; server UUID storage keys never derive from filenames. No file system paths, remote URL ingestion, uploaded scripts, HTML JavaScript or PDF actions are executed.

TXT/Markdown retain headings. HTML uses a DOM parser with active/non-body elements removed, then extracts text. Text PDF uses PDF.js text extraction and page numbers. Empty/scanned PDFs fail with OCR_UNSUPPORTED rather than pretending to succeed. No OCR, encrypted PDF/password support, Office parsing or remote fetch is claimed.

Document row locks serialize version numbers. Checksum + document + embedding space deduplicates repeated versions. Different documents may deliberately contain the same bytes because their ACLs/sources differ. Whole-version Chunk insertion and Ready transition are one transaction: errors cannot expose partial indexes. The previous Ready version remains available until a new one commits. Ingestion leases renew, expire, retry with new tokens and fence stale commits; maximum three attempts, bounded timeout and exponential availability backoff. Transient Embedding failures retry; invalid content/model/dimensions fail permanently. The stored embedding space must match the Worker.

## Chunker / Embedding Provider

Chunker uses configurable code-point chunk_size/overlap/max_chunks, normalized NFC offsets, original title, Markdown section and PDF page. Offset/end_offset refer to normalized Unicode code points, not original byte positions. Invalid overlap, empty and excessively long documents fail explicitly; no silent truncation. Token count is a conservative UTF-8-byte upper bound, not a model tokenizer. Per-call and per-document embedding budgets are bounded; ingestion packs batches within that bound.

MockEmbeddingProvider is deterministic, 32-dimensional and offline; explicit English/Chinese synonym fixtures make CI reproducible, not a claim of production semantic quality. HttpEmbeddingProvider implements an explicitly configured HTTPS OpenAI-compatible Embeddings endpoint, batch request/ordering validation, timeout, bounded retry, process-local request spacing, token budget, finite/nonzero vectors, usage and optional configured cost. It never assumes DeepSeek Chat supports embeddings. Model space includes endpoint hash, API model and dimensions, so changing endpoint/model/dimensions does not compare incompatible vectors. Both Web and Worker must use the same space. Real calls are opt-in and NOT VERIFIED without credentials. Official wire contract: [Embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

## Hybrid Search / ACL / RLS

Vector distances are calculated only over an authorized, materialized PostgreSQL CTE with tenant, explicit ACL, live document, Ready version, exact model/dimensions and metadata filters. Keyword search uses indexed `simple` FTS plus a literal Unicode substring score for Chinese/Japanese. Default retrieval uses current versions; explicit version_ids can select an authorized historical Ready version.

RRF uses k=60, up to 100 ranks per branch, stable UUID tie-breakers, top_k ≤20 (tool ≤10), and a vector similarity threshold. Keyword evidence may independently qualify a result. Exact search is the deliberate fallback strategy: this version has no ANN/HNSW recall loss under ACL filtering. It also has no large-corpus ANN scalability claim. Query statement_timeout is 3 seconds. CJK substring fallback handles exact phrases, not linguistic segmentation; a language tokenizer can replace that branch later.

No grant means no access. KB ownership supplies inherent management; explicit tenant/KB/document grants support user, role and same-tenant group. A tenant-level grant intentionally applies throughout its tenant. These are allow grants, not deny rules; to restrict an individual document, do not give that subject a broader tenant/KB grant. Grant/revoke/group operations are audited. RLS additionally protects raw chunks and bytes, so application filtering is not the security boundary. Viewer may only read explicitly authorized knowledge. Owner/Admin control ACL management; Member can create/write within authorized KBs. Caller tenant_id is rejected; session/membership select the context.

## Source Citation / Agent Retrieval / Runtime Integration

`search_knowledge` returns UNTRUSTED EXTERNAL CONTENT, full source IDs/version/chunk/title/page/section/excerpt/hash and `cite:UUID`. It runs through existing ToolRegistry authorization, policy/audit, tool budgets, deadlines, tool status SSE and the Tool Ledger; byte output is bounded. Documents and memory stay in tool role, never System instructions. Default new tools are disabled; enable explicitly through existing tool-policy API/UI. Memory writes/deletes cannot be configured without high-risk independent approval.

Citation validation checks actual snapshot membership, source identity, content/hash/version and current ACL/live status. Generated final text is buffered until this check, so fabricated citation IDs do not first leak through text-delta SSE. Valid citation IDs do not imply semantic faithfulness.

Snapshots bind run/tool-call, query hash, exact retrieval-config version, immutable version/chunk IDs, citation metadata, memory IDs and memory content hashes. Checkpoint/HITL resume rechecks them; deleted/revoked/changed/expired context fails closed. Tool authorization also rechecks snapshot validity immediately before actual invocation. Already succeeded tool calls are not rerouted or replayed. PromptOps pins remain the Day 12 source of Prompt/Model version identity; legacy unregistered agents keep their existing compatibility path.

Historical snapshots/checkpoints/tool-ledger evidence are audit data. They do not grant current execution permission. Revocation cannot undo already completed or in-flight external effects. There is no claim of globally atomic cancellation between a final authorization check and external network execution.

## Agent Memory / Session Summary / Retention

Conversation history remains in existing Persistence. Session Summary is a separate `session_summary` record with scope=session and an owned conversation/run source. `/api/memories/summary` is an explicit confirmed operation: deterministic bounded extractive compression from the caller's user/assistant history, excluding System/tool roles, with source reference and confidence 0.5. It is not automatically promoted into long-term memory or System context.

Long-term fact/preference memory requires explicit user confirmation via API/UI, or independently approved Agent memory_write. No automatic conversation scraping or inference persistence occurs. Scopes are tenant (admin-authored shared), user (owner), agent (owner plus Agent ID), session (owner plus conversation). Runtime memory tools bind Agent/session selectors to the actual server Job. Same-tenant users cannot read another user's private memory. Agent tools cannot select another Agent's private scope.

TTL is checked on every read; maximum content retention is 90 days from creation. Explicit forget immediately clears content to an empty tombstone and removes it from normal search/list. Worker retention erases expired content in bounded batches every minute. There is no vector/cache mirror of memory that could return a deleted copy. Snapshots use hashes and are invalidated when memory changes or disappears. Historical audit artifacts can retain previously authorized evidence; these artifacts are not a memory-search API and are revalidated before execution.

Documents are soft-deleted immediately from retrieval and retained with immutable source versions for audit. This release has no runtime physical document-history purge/restore API; retention/dump deletion is a provisioner-controlled follow-up requiring audit and FK handling. List endpoints are bounded and do not implement pagination.

## RAG Evaluation / Quality Gate

Day 11 schema, AgentRunner, ScorerRegistry, immutable reports and strict qualityGate now accept retrieval_recall_at_k, retrieval_precision_at_k, citation_validity, groundedness/faithfulness, answer_relevance, permission_leakage and memory_scope_violation. Safety failures cannot be omitted by assigning zero weight or removing the named scorers; execution/output safety invariants still fail the Gate.

`rag-v1.json` contains seven deterministic corpus cases: allowed, restricted, cross-tenant, old, deleted, injection and bilingual. Retrieval fixture execution goes through a registered Agent tool and produces observation evidence. This isolated regression corpus is not a benchmark of live tenant corpus retrieval; real PostgreSQL vector/FTS/ACL paths and runtime resume are separately exercised by integration tests. Do not conflate fixture quality with live-model intelligence.

Lexical groundedness/faithfulness deliberately returns inconclusive: overlap cannot establish semantics. Optional existing model_based Judge receives the untrusted answer and actual observation context, remains opt-in/advisory and uncertain. CI needs neither paid models nor paid embeddings. RAG Dataset/Run uses the existing `/evaluations` dashboard and durable Evaluation Worker.

## API / Dashboard

All APIs use Better Auth, tenant membership, RBAC, RLS, Zod, shared rate limits, safe errors and audit. No client actor/tenant claims are accepted. Non-readable resources return generic unavailable/empty lists; single-object mutations return NOT_FOUND rather than exposing existence.

| Route | Method / function |
|---|---|
| /api/knowledge/bases | GET list, POST create |
| /api/knowledge/bases/:id | POST rename/describe/soft-delete |
| /api/knowledge/bases/:id/documents | GET authorized documents/status |
| /api/knowledge/bases/:id/acl | GET grants, POST grant/revoke (optional document_id) |
| /api/knowledge/documents | POST base64 upload/new version and chunk config |
| /api/knowledge/documents/:id/versions | GET version/status/error/history metadata |
| /api/knowledge/documents/:id/delete | POST soft-delete |
| /api/knowledge/search | POST vector/keyword/hybrid debug, filters and citations |
| /api/knowledge/groups | POST audited same-tenant group/members |
| /api/memories | GET list/search by scope/agent/session/query; POST confirmed create |
| /api/memories/:id | POST update/TTL, DELETE forget |
| /api/memories/summary | POST confirmed extractive session summary |

`/knowledge` provides KB create/select, upload/version history/status, document deletion, ACL grant/revoke, Retrieval Playground (vector/keyword/RRF scores, citation and timing), Memory Scope/source/TTL/forget, explicit Session Summary and RAG Evaluation entry. The existing security dashboard manages tool policies. Page loads are guarded by user/tenant identity and request generation; old responses cannot repaint another tenant's data. Tab selection is controlled explicitly.

## Observability

Counters: knowledge_ingestion_total, knowledge_ingestion_failures_total, knowledge_retrieval_total, knowledge_embedding_tokens_total, agent_memory_operations_total, rag_citation_validation_failures_total. Histogram: knowledge_retrieval_duration_seconds. Labels are bounded provider/operation/mode/status/reason buckets. Trace attributes may associate document version, embedding space, KB and inherited Agent/Prompt identities. No document/query/memory text, embeddings or secrets enter ordinary logs/metrics. Authorized snapshots and encrypted checkpoints intentionally retain evidence separately.

## Tests / CI / Verification

Run with a PostgreSQL 17 + pgvector provisioner test URL:

```bash
export TEST_DATABASE_URL=postgresql://eap:eap_day13_test_password@127.0.0.1:5543/eap_test
pnpm check
pnpm test:e2e:knowledge
```

CI uses the same pgvector major, preserves Day 1–12 tests, adds Knowledge/RAG checks and strict CLI Gate, installs Chromium and uploads browser Trace/screenshots/reports. Root check contains both Risk and RAG CLI gates. Exact verified counts and freeze decisions are recorded in the companion acceptance report after the final runs.

## Known Limitations

No OCR; no arbitrary URL/Office ingestion; no linguistic CJK segmentation; no ANN scaling claim; no automatic memory capture; no automatic history rewrite; no physical audit-history purge; no claim that an untrusted document cannot persuade an unconstrained model. Enforcement comes from independent ACL/Tool Policy/HITL and output citation checks. Malicious runtime extensions, migration owners and configured provider endpoints remain trusted. PDF parsing has size/page/chunk limits but is not an OS sandbox; hostile-content deployments need process resource limits/container isolation. Real provider and remote CI results must be marked NOT VERIFIED unless actually executed. GitHub Actions configuration alone is not a green run.

最终本地验收：333 项 TypeScript 测试、Go race、11 个 Day 13 浏览器场景，以及 Day 12 的 15 个浏览器/4 个 API 回归通过。逐项映射、证据位置与冻结边界见 [Day 13 验收记录](day13-acceptance.md)。远程 CI 仍为 NOT VERIFIED。
