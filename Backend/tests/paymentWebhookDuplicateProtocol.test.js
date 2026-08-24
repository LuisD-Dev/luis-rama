import { jest } from '@jest/globals';
import { processStripeWebhookEvent } from '../services/paymentService.js';

describe('subscription webhook duplicate claim protocol', () => {
  test('classifies P2002 as duplicate only after finding the exact committed Stripe event', async () => {
    const uniqueError = Object.assign(new Error('event claim conflict'), {
      code: 'P2002',
    });
    const committedEvent = {
      id: 81,
      stripeEventId: 'evt_subscription_committed_duplicate',
      outcome: 'processed',
    };
    const db = {
      $transaction: jest.fn().mockRejectedValue(uniqueError),
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue(committedEvent),
      },
    };

    const result = await processStripeWebhookEvent(
      {
        id: committedEvent.stripeEventId,
        type: 'invoice.paid',
      },
      { db }
    );

    expect(result).toEqual({
      outcome: 'duplicate',
      eventType: 'invoice.paid',
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.paymentEvent.findUnique).toHaveBeenCalledWith({
      where: { stripeEventId: committedEvent.stripeEventId },
    });
  });

  test('propagates P2002 when the exact Stripe event was not committed', async () => {
    const uniqueError = Object.assign(new Error('unrelated unique conflict'), {
      code: 'P2002',
      meta: { target: ['provider', 'external_id'] },
    });
    const db = {
      $transaction: jest.fn().mockRejectedValue(uniqueError),
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    await expect(
      processStripeWebhookEvent(
        {
          id: 'evt_subscription_unrelated_conflict',
          type: 'invoice.paid',
        },
        { db }
      )
    ).rejects.toBe(uniqueError);
    expect(db.paymentEvent.findUnique).toHaveBeenCalledWith({
      where: { stripeEventId: 'evt_subscription_unrelated_conflict' },
    });
  });
});
