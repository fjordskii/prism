import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { copilot } from 'e2e/oauth/copilot';
import { ADMIN_TOKEN, DEMO_TOKEN } from './tests/support/env.ts';

// Local Prism with a fresh seeded DB. Tokens are throwaway test values for the
// local server only (never production tokens). HOLDOUT_PCT=0 keeps the random
// 10% holdout from making UI tests flaky; the holdout is tested via the API.
// PRISM_PLAN=selfhost matches the self-host default so authoring a new site is
// not a site-cap test. DEV_AUTH_EMAIL turns on the local session bypass.
// America/New_York makes the schedule-field regression observable (it skips in UTC).

const browser = { timezoneId: 'America/New_York' };

const app = {
  url: 'http://127.0.0.1:0',
  command: {
    executable: 'bun',
    args: ['tests/support/serve.ts'],
    env: {
      PORT: '{port}',
      ADMIN_TOKEN,
      DEMO_TOKEN,
      HOLDOUT_PCT: '0',
      PRISM_PLAN: 'selfhost',
      DEV_AUTH_EMAIL: 'e2e-owner@prism.test',
    },
    startupTimeout: 60_000,
    log: '.e2e/logs/app.log',
  },
};

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    { name: 'desktop', engine: web(browser), app },
    { name: 'mobile', engine: web({ ...browser, viewport: { width: 390, height: 844 } }), app },
  ],
  // Model for agent.* steps: a GitHub Copilot subscription (`npx e2e login github-copilot`).
  // Deterministic tests need no model.
  agents: {
    default: {
      model: copilot('gpt-5.4-mini'),
      system: 'You are a thorough QA agent testing Prism, a website personalization product. Verify every outcome on screen.',
      context:
        'The demo storefront is a fictional candle shop called Linden. A persona simulator panel sits bottom-right on desktop and along the bottom on a phone. ' +
        'Picking a persona sends traits to Prism and reloads the page; the hero and sections then show that persona\'s variant.',
    },
  },
  timeout: 90_000,
} satisfies E2EConfig;
