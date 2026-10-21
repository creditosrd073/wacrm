-- ============================================================
-- 063_ai_usage_log_catalog_search_trace.sql — Mission D audit (Oct
-- 2026), Fase 7 ("OBSERVABILIDAD Y DIAGNÓSTICO").
--
-- Until now `ai_usage_log` recorded THAT catalog tools ran
-- (tool_call_count, catalog_used, catalog_attached — migration 049)
-- but not what each search_catalog call actually found, so a broad
-- query that silently came back empty/partial, or a reply the
-- commercial-claims verifier (src/lib/ai/catalog/verify-claims.ts) had
-- to intercept, left no queryable trace of WHERE in the pipeline it
-- happened (the DB query itself, pagination, classification, or the
-- model just not using real results).
--
-- Purely additive, nullable columns — no existing row is affected,
-- every row logged before this migration reads back as "not computed"
-- (NULL), same discipline as every prior ai_usage_log extension
-- (049/051/052/061). Never touches RLS: same table, same existing
-- SELECT (admin+) / no `authenticated` write policy — a new nullable
-- column needs no new policy.
--
-- catalog_search_trace deliberately holds ONLY what the model itself
-- already received back from search_catalog (query text, counts,
-- completion status, the honest productKindSplit signal) — never a
-- raw conversation, never a customer phone number/name, never
-- credentials/tokens. A product search query is business data about
-- the CATALOG, not personal data about the customer.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS catalog_search_trace jsonb,
  ADD COLUMN IF NOT EXISTS search_completion_status text,
  ADD COLUMN IF NOT EXISTS tool_call_budget_max integer,
  ADD COLUMN IF NOT EXISTS commercial_validation_passed boolean,
  ADD COLUMN IF NOT EXISTS commercial_validation_issue_count integer;

COMMENT ON COLUMN ai_usage_log.catalog_search_trace IS
  'One entry per search_catalog call this turn (src/lib/ai/catalog/observability.ts::buildCatalogSearchTrace) — {query, offset, limit, returned, total, hasMore, status, productKindSplit}. Derived AFTER the fact from the SAME whitelisted result the model already received back, never a new query. NULL when no search_catalog call happened this turn, or the row predates this column.';

COMMENT ON COLUMN ai_usage_log.search_completion_status IS
  'The single WORST (most actionable) status across this turn''s own catalog_search_trace entries — error > parcial > vacia > completa — so a turn with even one failed/partial search is never summarized as fully successful. One of: completa, parcial, vacia, error. NULL when no search_catalog call happened this turn, or the row predates this column.';

COMMENT ON COLUMN ai_usage_log.tool_call_budget_max IS
  'MAX_TOOL_CALLS_PER_GENERATE (src/lib/ai/defaults.ts) at the time of this call, recorded alongside the existing tool_call_count so budget exhaustion (count >= max) is computable even if the constant changes later. NULL when the row predates this column.';

COMMENT ON COLUMN ai_usage_log.commercial_validation_passed IS
  'Whether verifyCommercialClaims (src/lib/ai/catalog/verify-claims.ts) found every price/quantity claim in the reply backed by this turn''s real tool results (or carried context, for price). NULL when verification did not run this call (no catalog tools attached, no reply text, or a handoff) — never coerced to true/false for "not applicable".';

COMMENT ON COLUMN ai_usage_log.commercial_validation_issue_count IS
  'How many unsupported price/quantity claims verifyCommercialClaims found (0 when commercial_validation_passed is true). NULL under the same "did not run" condition as commercial_validation_passed — never 0 for "not applicable".';
