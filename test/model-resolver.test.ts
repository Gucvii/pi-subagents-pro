import { describe, expect, it } from "vitest";
import { type ModelRegistry, resolveExactModel } from "../src/model-resolver.js";

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
];

function makeRegistry(models = MODELS, available?: typeof MODELS): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models.find(model => model.provider === provider && model.id === modelId);
    },
    getAll() {
      return models;
    },
    getAvailable: available ? () => available : undefined,
  };
}

describe("resolveExactModel", () => {
  it("resolves an exact authenticated provider/modelId pair", () => {
    expect(resolveExactModel("anthropic/claude-opus-4-6", makeRegistry())).toEqual(MODELS[0]);
  });

  it("rejects fuzzy, empty, and incomplete identities", () => {
    expect(resolveExactModel("", makeRegistry())).toContain("Exact model required");
    expect(resolveExactModel("opus", makeRegistry())).toContain("Exact model required");
    expect(resolveExactModel("anthropic/opus", makeRegistry())).toContain("Exact model not available");
  });

  it("uses getAll when the registry has no getAvailable method", () => {
    const registry = makeRegistry();
    expect(registry.getAvailable).toBeUndefined();
    expect(resolveExactModel("openai/gpt-4o", registry)).toEqual(MODELS[1]);
  });

  it("never falls back to another provider", () => {
    const gateway = { id: "claude-opus-4-6", name: "Claude Opus", provider: "openrouter" };
    expect(resolveExactModel("anthropic/claude-opus-4-6", makeRegistry([gateway]))).toContain(
      "Exact model not available",
    );
  });

  it("rejects exact models without configured authentication", () => {
    expect(resolveExactModel("openai/gpt-4o", makeRegistry(MODELS, [MODELS[0]]))).toContain(
      "Exact model not available",
    );
  });
});
