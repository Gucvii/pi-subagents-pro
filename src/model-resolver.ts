/**
 * Strict model resolution for exact authenticated provider/modelId identities.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Resolve only an exact provider/modelId pair.
 *
 * Agent execution uses this strict path so the requested, displayed, and
 * executed model can never diverge through fuzzy matching or provider fallback.
 */
export function resolveExactModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(input);
  if (!match) {
    return `Exact model required: "${input}". Use the full provider/modelId form.`;
  }

  const [, provider, modelId] = match;
  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const exact = available.find(model => model.provider === provider && model.id === modelId);
  if (exact) {
    const found = registry.find(provider, modelId);
    if (found) return found;
  }

  const modelList = available
    .map(model => `  ${model.provider}/${model.id}`)
    .sort()
    .join("\n");
  return `Exact model not available: "${input}". Model identities are case-sensitive; copy provider/modelId exactly from the registry.\n\nAvailable models:\n${modelList}`;
}
