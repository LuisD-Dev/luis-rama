import {
  PAYMENT_STATUSES,
  applyTransition,
} from '../../services/paymentStateMachine.js';

const PLAN_ORDER = { basico: 1, pro: 2, master: 3 };

export class SeededRandom {
  constructor(seed) {
    this.state = (Number(seed) >>> 0) || 1;
  }

  next() {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  pick(values) {
    return values[Math.floor(this.next() * values.length)];
  }
}

export class BarrierScheduler {
  constructor(schedule) {
    this.schedule = schedule;
    this.cursor = 0;
    this.waiting = new Map();
    this.trace = [];
  }

  async await(worker, barrier) {
    const key = `${worker}:${barrier}`;
    return new Promise((resolve) => {
      this.waiting.set(key, resolve);
    });
  }

  async drain() {
    while (this.cursor < this.schedule.length) {
      const next = this.schedule[this.cursor];
      const key = `${next.worker}:${next.barrier}`;
      const deadline = Date.now() + 5000;
      while (!this.waiting.has(key)) {
        if (Date.now() >= deadline) {
          throw new Error(`Scheduler deadlock at ${key}; schedule: ${formatSchedule(this.trace)}`);
        }
        await Promise.resolve();
      }
      this.waiting.get(key)();
      this.waiting.delete(key);
      this.trace.push(next);
      this.cursor += 1;
      await Promise.resolve();
    }
  }
}

export class FakeStripeClient {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.intents = new Map();
    this.calls = [];
  }

  async createPaymentIntent(worker, { idempotencyKey, paymentId }) {
    this.calls.push({ worker, idempotencyKey, paymentId });
    await this.scheduler.await(worker, 'stripeNetwork');
    let intent = this.intents.get(idempotencyKey);
    if (!intent) {
      intent = {
        id: `pi_fake_${idempotencyKey}`,
        status: 'requires_confirmation',
        paymentId,
      };
      this.intents.set(idempotencyKey, intent);
    }
    return { ...intent };
  }
}

export class ScenarioStore {
  constructor() {
    this.nextPaymentId = 1;
    this.nextEventId = 1;
    this.payments = [];
    this.events = [];
    this.users = new Map([[1, { id: 1, planTier: null }]]);
    this.entitlementActivations = new Map();
    this.successHistory = [];
    this.succeededPaymentIds = new Set();
  }

  createOrLoadPayment({ userId, planTier, idempotencyKey }) {
    const existing = this.payments.find((payment) => payment.idempotencyKey === idempotencyKey);
    if (existing) return { ...existing };
    const payment = {
      id: this.nextPaymentId++,
      userId,
      planTier,
      idempotencyKey,
      status: PAYMENT_STATUSES.PENDING,
      stripePaymentIntentId: null,
    };
    this.payments.push(payment);
    return { ...payment };
  }

  attachPaymentIntent(paymentId, stripePaymentIntentId) {
    const payment = this.payments.find(({ id }) => id === paymentId);
    if (!payment.stripePaymentIntentId) payment.stripePaymentIntentId = stripePaymentIntentId;
    return { ...payment };
  }

  claimEvent(event) {
    const duplicate = this.events.find(({ stripeEventId }) => stripeEventId === event.id);
    if (duplicate) return { event: { ...duplicate }, created: false };
    const stored = {
      id: this.nextEventId++,
      stripeEventId: event.id,
      type: event.type,
      paymentId: null,
      outcome: 'processing',
    };
    this.events.push(stored);
    return { event: { ...stored }, created: true };
  }

  updateEvent(stripeEventId, data) {
    const stored = this.events.find(({ stripeEventId: id }) => id === stripeEventId);
    Object.assign(stored, data);
  }

  tx() {
    return {
      payment: {
        findUnique: async ({ where }) => {
          const payment = where.id != null
            ? this.payments.find(({ id }) => id === where.id)
            : this.payments.find(({ stripePaymentIntentId }) => stripePaymentIntentId === where.stripePaymentIntentId);
          return payment ? { ...payment } : null;
        },
        updateMany: async ({ where, data }) => {
          const payment = this.payments.find(({ id, status }) => id === where.id && status === where.status);
          if (!payment) return { count: 0 };
          Object.assign(payment, data);
          return { count: 1 };
        },
      },
    };
  }

  async transition(paymentId, targetStatus) {
    return applyTransition(this.tx(), paymentId, targetStatus, {
      source: 'concurrency_harness',
      actorType: 'system',
      actorId: paymentId,
      reason: 'deterministic concurrency schedule',
    });
  }

  activateEntitlement(payment) {
    const activationCount = this.entitlementActivations.get(payment.stripePaymentIntentId) || 0;
    this.entitlementActivations.set(payment.stripePaymentIntentId, activationCount + 1);
    const user = this.users.get(payment.userId);
    user.planTier = payment.planTier;
    this.successHistory.push({ paymentId: payment.id, planTier: payment.planTier });
  }
}

const WORKER_BARRIERS = {
  'api-first': ['afterDbInsert', 'stripeNetwork', 'afterStripeAttach'],
  'api-double-click': ['afterDbInsert', 'stripeNetwork', 'afterStripeAttach'],
  'success-webhook': ['afterDbInsert', 'afterEventClaim', 'beforeEntitlement'],
  'success-retry': ['afterDbInsert', 'afterEventClaim', 'beforeEntitlement'],
  'failed-webhook': ['afterDbInsert', 'afterEventClaim', 'beforeEntitlement'],
};

const buildWorkerSteps = (workers) => workers.flatMap((worker) =>
  WORKER_BARRIERS[worker].map((barrier) => ({ worker, barrier }))
);

export const generateSchedule = (seed, workers) => {
  const random = new SeededRandom(seed);
  const progress = new Map(workers.map((worker) => [worker, 0]));
  const schedule = [];
  const steps = buildWorkerSteps(workers);
  while (schedule.length < steps.length) {
    const ready = steps.filter(({ worker, barrier }) => {
      const index = progress.get(worker);
      return WORKER_BARRIERS[worker][index] === barrier;
    });
    const next = random.pick(ready);
    schedule.push(next);
    progress.set(next.worker, progress.get(next.worker) + 1);
  }
  return schedule;
};

const readPaymentById = (store, id) => store.payments.find((payment) => payment.id === id);

const runPaymentMethod = async ({ store, stripe, scheduler, worker, idempotencyKey, planTier }) => {
  const payment = store.createOrLoadPayment({ userId: 1, planTier, idempotencyKey });
  await scheduler.await(worker, 'afterDbInsert');
  const intent = await stripe.createPaymentIntent(worker, { idempotencyKey, paymentId: payment.id });
  const attached = store.attachPaymentIntent(payment.id, intent.id);
  await scheduler.await(worker, 'afterStripeAttach');
  return attached;
};

const runWebhook = async ({ store, scheduler, worker, event, mutation = null }) => {
  await scheduler.await(worker, 'afterDbInsert');
  const claim = store.claimEvent(event);
  await scheduler.await(worker, 'afterEventClaim');
  if (!claim.created) {
    await scheduler.await(worker, 'beforeEntitlement');
    return { outcome: 'duplicate' };
  }
  const payment = store.payments.find(({ stripePaymentIntentId, id }) =>
    stripePaymentIntentId === event.data.object.id || id === event.data.object.metadata?.paymentId
  );
  if (!payment) throw new Error(`payment not found for ${event.data.object.id}`);
  store.attachPaymentIntent(payment.id, event.data.object.id);
  store.updateEvent(event.id, { paymentId: payment.id });
  if (event.type === 'payment_intent.payment_failed') {
    await scheduler.await(worker, 'beforeEntitlement');
    if (mutation === 'overwriteSucceededWithFailed' && payment.status === PAYMENT_STATUSES.SUCCEEDED) {
      payment.status = PAYMENT_STATUSES.FAILED;
    } else if (payment.status !== PAYMENT_STATUSES.SUCCEEDED) {
      await store.transition(payment.id, PAYMENT_STATUSES.FAILED);
    }
    store.updateEvent(event.id, { outcome: 'processed' });
    return { outcome: 'processed' };
  }
  try {
    await store.transition(payment.id, PAYMENT_STATUSES.PROCESSING);
  } catch (error) {
    if (error.code === 'PAYMENT_STATUS_CONFLICT') {
      await scheduler.await(worker, 'beforeEntitlement');
      store.updateEvent(event.id, { outcome: 'ignored_terminal' });
      return { outcome: 'ignored_terminal' };
    }
    throw error;
  }
  await scheduler.await(worker, 'beforeEntitlement');
  let transitioned;
  try {
    transitioned = await store.transition(payment.id, PAYMENT_STATUSES.SUCCEEDED);
  } catch (error) {
    if (error.code === 'PAYMENT_STATUS_CONFLICT') {
      store.updateEvent(event.id, { outcome: 'ignored_terminal' });
      return { outcome: 'ignored_terminal' };
    }
    throw error;
  }
  if (transitioned.applied) {
    store.succeededPaymentIds.add(payment.id);
    store.activateEntitlement(readPaymentById(store, payment.id));
  }
  store.updateEvent(event.id, { outcome: 'processed' });
  return { outcome: 'processed' };
};

export const assertInvariants = (store) => {
  const paymentKeys = new Set();
  for (const payment of store.payments) {
    if (paymentKeys.has(payment.idempotencyKey)) throw new Error('Invariant 1 violated: duplicate idempotencyKey');
    paymentKeys.add(payment.idempotencyKey);
  }
  const eventIds = new Set();
  for (const event of store.events) {
    if (eventIds.has(event.stripeEventId)) throw new Error('Invariant 3 violated: duplicate stripeEventId');
    eventIds.add(event.stripeEventId);
  }
  for (const [stripePaymentIntentId, count] of store.entitlementActivations) {
    if (count > 1) throw new Error(`Invariant 2 violated: ${stripePaymentIntentId} activated ${count} times`);
  }
  for (const payment of store.payments) {
    if (store.succeededPaymentIds.has(payment.id) && payment.status === PAYMENT_STATUSES.FAILED) {
      throw new Error('Invariant 4 violated: succeeded overwritten by failed');
    }
  }
  const successfulPayments = store.successHistory;
  if (successfulPayments.length) {
    const latestTier = successfulPayments[successfulPayments.length - 1].planTier;
    if (store.users.get(1).planTier !== latestTier) throw new Error('Invariant 5 violated: user tier is not latest succeeded tier');
  }
  return true;
};

export const runScenario = async ({ seed, mutation = null } = {}) => {
  const workers = ['api-first', 'api-double-click', 'success-webhook', 'success-retry', 'failed-webhook'];
  const schedule = generateSchedule(seed, workers);
  const scheduler = new BarrierScheduler(schedule);
  const store = new ScenarioStore();
  const stripe = new FakeStripeClient(scheduler);
  const idempotencyKey = `scenario-${seed}`;
  const successEvent = {
    id: `evt-success-${seed}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: `pi_fake_${idempotencyKey}`, metadata: { paymentId: 1 } } },
  };
  const failedEvent = {
    id: `evt-failed-${seed}`,
    type: 'payment_intent.payment_failed',
    data: { object: { id: `pi_fake_${idempotencyKey}`, metadata: { paymentId: 1 } } },
  };
  const workersToRun = [
    runPaymentMethod({ store, stripe, scheduler, worker: 'api-first', idempotencyKey, planTier: 'pro' }),
    runPaymentMethod({ store, stripe, scheduler, worker: 'api-double-click', idempotencyKey, planTier: 'master' }),
    runWebhook({ store, scheduler, worker: 'success-webhook', event: successEvent, mutation }),
    runWebhook({ store, scheduler, worker: 'success-retry', event: successEvent, mutation }),
    runWebhook({ store, scheduler, worker: 'failed-webhook', event: failedEvent, mutation }),
  ];
  try {
    await Promise.all([scheduler.drain(), ...workersToRun]);
  } catch (error) {
    error.message = `${error.message}; seed=${seed}; schedule=${formatSchedule(scheduler.trace)}`;
    throw error;
  }
  assertInvariants(store);
  return { seed, schedule: scheduler.trace, store, stripe };
};

export const seedFromArgv = () => {
  const argument = process.argv.find((value) => value.startsWith('--seed='));
  return argument ? Number(argument.slice('--seed='.length)) : null;
};

export const formatSchedule = (schedule) => schedule
  .map(({ worker, barrier }) => `${worker}:${barrier}`)
  .join(' -> ');

export const planOrder = PLAN_ORDER;
