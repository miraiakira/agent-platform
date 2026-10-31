export interface ModelPrice {
  provider: string; model: string; input: number; output: number;
  unit: "per_million_tokens"; effectiveAt: string; version: string;
}
// Real model prices must be supplied by the operator. Unknown never means free.
const defaults: ModelPrice[] = [{ provider: "mock", model: "mock-model", input: 0, output: 0,
  unit: "per_million_tokens", effectiveAt: "2026-01-01T00:00:00Z", version: "mock-v1" }];
export function loadPrices(raw = process.env.MODEL_PRICES_JSON): ModelPrice[] {
  if (!raw) return defaults;
  try {
    const prices: unknown = JSON.parse(raw);
    if (!Array.isArray(prices) || !prices.every((p) => p && typeof p.provider === "string" && typeof p.model === "string" &&
      typeof p.version === "string" && p.unit === "per_million_tokens" && Number.isFinite(Date.parse(p.effectiveAt)) &&
      Number.isFinite(p.input) && p.input >= 0 && Number.isFinite(p.output) && p.output >= 0)) return [];
    return prices;
  } catch { return []; }
}
export function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number,
  at = new Date(), prices = loadPrices()) {
  const price = prices.filter((p) => p.provider === provider && p.model === model && Date.parse(p.effectiveAt) <= at.getTime())
    .sort((a,b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
  return { usd: price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null,
    price: price ?? null, kind: "estimated" as const };
}
