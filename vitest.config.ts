import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only pure logic is unit-tested here — anything that talks to AWS or
    // Stripe over the network belongs to the chaos/integration scripts
    // (scripts/chaos-*.ts, scripts/verify-roundtrip.sh), which need a real
    // deployed stack and are run by hand, not on every push.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
