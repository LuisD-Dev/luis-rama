import prisma from '../utils/prismaClient.js';

const VISIT_KEY = 'page_visits';

const getMonthBounds = (date = new Date()) => {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { start, end };
};

const getPreviousMonthBounds = (date = new Date()) => {
  const start = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const end = new Date(date.getFullYear(), date.getMonth(), 1);
  return { start, end };
};

const buildRangeFilter = (start, end) => ({
  createdAt: {
    gte: start,
    lt: end,
  },
});

const calculateRevenueChange = (currentRevenue, previousRevenue) => {
  if (previousRevenue === 0) {
    return currentRevenue > 0 ? 100 : 0;
  }

  return Number((((currentRevenue - previousRevenue) / previousRevenue) * 100).toFixed(2));
};

const buildActiveSubscriptions = async () => {
  const completedPayments = await prisma.payment.findMany({
    where: { status: 'completed' },
    orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
    select: {
      userId: true,
      planTier: true,
      createdAt: true,
    },
  });

  const latestPlanByUser = new Map();
  for (const payment of completedPayments) {
    if (!latestPlanByUser.has(payment.userId)) {
      latestPlanByUser.set(payment.userId, payment.planTier || null);
    }
  }

  const counts = { basico: 0, pro: 0, master: 0 };
  for (const tier of latestPlanByUser.values()) {
    if (tier && tier in counts) {
      counts[tier] += 1;
    }
  }

  return {
    ...counts,
    total: counts.basico + counts.pro + counts.master,
  };
};

export const recordVisit = async (_req, res) => {
  try {
    const stat = await prisma.siteStat.upsert({
      where: { key: VISIT_KEY },
      update: { value: { increment: 1 } },
      create: { key: VISIT_KEY, value: 1 },
    });

    res.json({ total: stat.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getVisitStats = async (_req, res) => {
  try {
    const visits = await prisma.siteStat.findUnique({ where: { key: VISIT_KEY } });
    const total = visits?.value ?? 0;

    const studentCount = await prisma.user.count({
      where: { NOT: { role: 'admin' } },
    });

    res.json({ pageVisits: total, studentCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAdminStats = async (_req, res) => {
  try {
    const visits = await prisma.siteStat.findUnique({ where: { key: VISIT_KEY } });
    const pageVisits = visits?.value ?? 0;

    const studentCount = await prisma.user.count({
      where: { NOT: { role: 'admin' } },
    });

    const now = new Date();
    const thisMonth = getMonthBounds(now);
    const lastMonth = getPreviousMonthBounds(now);

    const [revenueThisMonthAgg, revenueLastMonthAgg, activeSubscriptions] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          status: 'completed',
          ...buildRangeFilter(thisMonth.start, thisMonth.end),
        },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: {
          status: 'completed',
          ...buildRangeFilter(lastMonth.start, lastMonth.end),
        },
        _sum: { amount: true },
      }),
      buildActiveSubscriptions(),
    ]);

    const revenueThisMonth = Number((revenueThisMonthAgg._sum.amount || 0).toFixed(2));
    const revenueLastMonth = Number((revenueLastMonthAgg._sum.amount || 0).toFixed(2));
    const revenueChange = calculateRevenueChange(revenueThisMonth, revenueLastMonth);

    res.json({
      pageVisits,
      studentCount,
      revenueThisMonth,
      revenueLastMonth,
      revenueChange,
      activeSubscriptions,
      currency: 'USD',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getUserStats = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = Number(id);

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getContentStats = async (req, res) => {
  try {
    const { id } = req.params;
    const contentId = Number(id);

    const content = await prisma.content.findUnique({
      where: { id: contentId },
    });

    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    res.json({ content: { id: content.id, title: content.title } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
