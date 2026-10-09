import type { ModelProvider, ModelRequest, ModelResponse, ModelUsage } from './model-provider';

export interface FakeScript {
  text: string;
  usage?: Partial<ModelUsage>;
  modelId?: string;
  stopReason?: ModelResponse['stopReason'];
}

/** Deterministic, scriptable ModelProvider for tests. No network, no cost. */
export class FakeModelProvider implements ModelProvider {
  private readonly queue: FakeScript[];
  public readonly calls: ModelRequest[] = [];

  constructor(scripts: FakeScript[] = []) {
    this.queue = [...scripts];
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const s = this.queue.shift() ?? { text: 'ok' };
    return {
      text: s.text,
      modelId: s.modelId ?? `fake-${req.tier}`,
      usage: {
        inputTokens: s.usage?.inputTokens ?? 100,
        outputTokens: s.usage?.outputTokens ?? 200,
        cacheTokens: s.usage?.cacheTokens ?? 0,
      },
      stopReason: s.stopReason ?? 'end',
    };
  }
}
