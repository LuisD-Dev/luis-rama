import {
  assertInvariants,
  formatSchedule,
  runScenario,
  seedFromArgv,
} from './harness.js';

describe('deterministic payment concurrency harness', () => {
  const requestedSeed = seedFromArgv();
  const seeds = requestedSeed == null ? [1, 7, 42, 12345, 9001] : [requestedSeed];

  test.each(seeds)('holds all invariants for seed %i', async (seed) => {
    const result = await runScenario({ seed });
    expect(() => assertInvariants(result.store)).not.toThrow();
    expect(result.store.payments).toHaveLength(1);
    expect(result.store.events).toHaveLength(2);
  });

  test('replays the same compact schedule for a seed', async () => {
    const first = await runScenario({ seed: 12345 });
    const second = await runScenario({ seed: 12345 });

    expect(formatSchedule(first.schedule)).toBe(formatSchedule(second.schedule));
  });

  test('catches a deliberately broken terminal mutation', async () => {
    await expect(
      runScenario({ seed: 9001, mutation: 'overwriteSucceededWithFailed' })
    ).rejects.toThrow('Invariant 4 violated');
  });
});
