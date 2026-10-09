import { describe, it, expect } from 'vitest';
import { FakeModelProvider } from './fake-model-provider';
import { AnthropicModelProvider } from './anthropic-model-provider';
import { getModelProvider } from './model-provider-factory';

describe('getModelProvider', () => {
  it('returns a FakeModelProvider for "fake"', () => {
    expect(getModelProvider('fake')).toBeInstanceOf(FakeModelProvider);
  });

  it('returns an AnthropicModelProvider for "anthropic"', () => {
    expect(getModelProvider('anthropic')).toBeInstanceOf(AnthropicModelProvider);
  });

  it('throws for an unknown provider name', () => {
    expect(() => getModelProvider('bedrock')).toThrow('model provider "bedrock" is not configured');
  });
});
