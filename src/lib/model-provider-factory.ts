import type { ModelProvider } from './model-provider';
import { FakeModelProvider } from './fake-model-provider';
import { AnthropicModelProvider } from './anthropic-model-provider';

/**
 * Constructs the ModelProvider named on an agent_delivery_runs row
 * (`run.provider`). 'fake' is deterministic/offline; 'anthropic' drives real
 * Claude models (Slice 3b). Any other name throws rather than silently falling
 * back to fake — a run must never run "for free" on a fake while the operator
 * believes it is billing real usage.
 */
export function getModelProvider(name: string): ModelProvider {
  if (name === 'fake') return new FakeModelProvider();
  if (name === 'anthropic') return new AnthropicModelProvider();
  throw new Error(`model provider "${name}" is not configured`);
}
