import type { CompiledCatalog } from "../../domain/catalog.ts";

/**
 * Short display names. A curated catalog names its models deliberately (`sol`, `opus`), so those
 * keys are kept. A derived key is `provider.id`; its last meaningful id segment is the name people
 * use (`gpt-5.6-sol` → `sol`, `claude-haiku-4-5` → `haiku`). A collision falls back to the full id,
 * because two seats wearing one name would misreport the route.
 */
export function displayAliases(catalog: CompiledCatalog): ReadonlyMap<string, string> {
  const qualifier = /^(?:\d[\w.]*|v\d[\w.]*|latest|preview|exp|experimental|beta|alpha)$/i;
  const short = new Map<string, string>();
  for (const model of catalog.models) {
    if (!model.key.startsWith(`${model.provider}.`)) { short.set(model.key, model.key); continue; }
    const word = model.id.split(/[-_/:]/).filter(segment => segment && !qualifier.test(segment)).at(-1);
    short.set(model.key, (word ?? model.id).toLowerCase());
  }
  const uses = new Map<string, number>();
  for (const alias of short.values()) uses.set(alias, (uses.get(alias) ?? 0) + 1);
  return new Map([...short].map(([key, alias]) => [key, uses.get(alias)! > 1 ? catalog.model(key).id : alias]));
}
