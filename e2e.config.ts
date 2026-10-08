import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { anthropic } from '@ai-sdk/anthropic';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3123' } }],
  agents: {
    default: {
      // Cheapest tool-capable Anthropic model per audit's cost constraint.
      model: anthropic('claude-haiku-4-5'),
      maxSteps: 40,
      maxModelCalls: 40,
    },
  },
} satisfies E2EConfig;
