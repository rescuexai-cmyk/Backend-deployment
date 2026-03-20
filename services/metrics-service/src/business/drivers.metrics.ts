/**
 * Driver Metrics Collector
 * Collects all driver-related KPIs and formats them for Prometheus
 */

import { prisma, logger } from '@raahi/shared';
import { withCache, metricsCache } from './metrics.cache';

interface DriverStats {
  total: number;
  active: number;
  verified: number;
  online: number;
  avgRating: number;
  totalEarnings: number;
  avgEarnings: number;
}

interface DriverByCity {
  city: string;
  count: number;
  avgRating: number;
  avgEarnings: number;
}

interface DriverByVehicleType {
  vehicleType: string;
  count: number;
  avgRating: number;
}

interface RatingDistribution {
  band: string;
  count: number;
}

interface OnboardingStats {
  pending: number;
  inProgress: number;
  completed: number;
  rejected: number;
}

interface RetentionStats {
  active30d: number;
  active7d: number;
  newDrivers30d: number;
  churnedDrivers30d: number;
  retentionRate30d: number;
}

const CACHE_TTL = 60000; // 60 seconds
const CACHE_KEY_PREFIX = 'driver_metrics_';

async function getDriverStats(): Promise<DriverStats> {
  return withCache(`${CACHE_KEY_PREFIX}stats`, async () => {
    const [total, active, verified, online, aggregates] = await Promise.all([
      prisma.driver.count(),
      prisma.driver.count({ where: { isActive: true } }),
      prisma.driver.count({ where: { isVerified: true } }),
      prisma.driver.count({ where: { isOnline: true } }),
      prisma.driver.aggregate({
        _avg: { rating: true, totalEarnings: true },
        _sum: { totalEarnings: true },
      }),
    ]);

    return {
      total,
      active,
      verified,
      online,
      avgRating: aggregates._avg.rating || 0,
      totalEarnings: Number(aggregates._sum.totalEarnings) || 0,
      avgEarnings: Number(aggregates._avg.totalEarnings) || 0,
    };
  }, CACHE_TTL);
}

async function getDriversByOnboardingStatus(): Promise<OnboardingStats> {
  return withCache(`${CACHE_KEY_PREFIX}onboarding`, async () => {
    const statuses = await prisma.driver.groupBy({
      by: ['onboardingStatus'],
      _count: true,
    });

    const result: OnboardingStats = {
      pending: 0,
      inProgress: 0,
      completed: 0,
      rejected: 0,
    };

    for (const s of statuses) {
      const status = s.onboardingStatus;
      if (status === 'COMPLETED') {
        result.completed = s._count;
      } else if (status === 'REJECTED') {
        result.rejected = s._count;
      } else if (status === 'EMAIL_COLLECTION' || status === 'LANGUAGE_SELECTION') {
        result.pending += s._count;
      } else {
        result.inProgress += s._count;
      }
    }

    return result;
  }, CACHE_TTL);
}

async function getRatingDistribution(): Promise<RatingDistribution[]> {
  return withCache(`${CACHE_KEY_PREFIX}rating_dist`, async () => {
    const drivers = await prisma.driver.findMany({
      select: { rating: true },
      where: { rating: { gt: 0 } },
    });

    const bands: Record<string, number> = {
      '0.0-1.0': 0,
      '1.0-2.0': 0,
      '2.0-3.0': 0,
      '3.0-3.5': 0,
      '3.5-4.0': 0,
      '4.0-4.5': 0,
      '4.5-5.0': 0,
    };

    for (const d of drivers) {
      const r = d.rating;
      if (r < 1) bands['0.0-1.0']++;
      else if (r < 2) bands['1.0-2.0']++;
      else if (r < 3) bands['2.0-3.0']++;
      else if (r < 3.5) bands['3.0-3.5']++;
      else if (r < 4) bands['3.5-4.0']++;
      else if (r < 4.5) bands['4.0-4.5']++;
      else bands['4.5-5.0']++;
    }

    return Object.entries(bands).map(([band, count]) => ({ band, count }));
  }, CACHE_TTL);
}

async function getRetentionStats(): Promise<RetentionStats> {
  return withCache(`${CACHE_KEY_PREFIX}retention`, async () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [active30d, active7d, newDrivers30d, oldActiveDrivers] = await Promise.all([
      prisma.driver.count({
        where: { lastActiveAt: { gte: thirtyDaysAgo } },
      }),
      prisma.driver.count({
        where: { lastActiveAt: { gte: sevenDaysAgo } },
      }),
      prisma.driver.count({
        where: { joinedAt: { gte: thirtyDaysAgo } },
      }),
      prisma.driver.count({
        where: {
          joinedAt: { lt: thirtyDaysAgo, gte: sixtyDaysAgo },
          lastActiveAt: { gte: thirtyDaysAgo },
        },
      }),
    ]);

    const driversFrom30to60DaysAgo = await prisma.driver.count({
      where: { joinedAt: { lt: thirtyDaysAgo, gte: sixtyDaysAgo } },
    });

    const retentionRate30d = driversFrom30to60DaysAgo > 0
      ? (oldActiveDrivers / driversFrom30to60DaysAgo) * 100
      : 0;

    const churnedDrivers30d = driversFrom30to60DaysAgo - oldActiveDrivers;

    return {
      active30d,
      active7d,
      newDrivers30d,
      churnedDrivers30d: Math.max(0, churnedDrivers30d),
      retentionRate30d: Math.round(retentionRate30d * 100) / 100,
    };
  }, CACHE_TTL);
}

async function getDriversByVehicleType(): Promise<DriverByVehicleType[]> {
  return withCache(`${CACHE_KEY_PREFIX}by_vehicle`, async () => {
    const groups = await prisma.driver.groupBy({
      by: ['vehicleType'],
      _count: true,
      _avg: { rating: true },
      where: { vehicleType: { not: null } },
    });

    return groups.map((g) => ({
      vehicleType: g.vehicleType || 'unknown',
      count: g._count,
      avgRating: g._avg.rating || 0,
    }));
  }, CACHE_TTL);
}

async function getEarningsStats(): Promise<{ total: number; avg: number; median: number }> {
  return withCache(`${CACHE_KEY_PREFIX}earnings`, async () => {
    const aggregates = await prisma.driver.aggregate({
      _sum: { totalEarnings: true },
      _avg: { totalEarnings: true },
    });

    const driversWithEarnings = await prisma.driver.findMany({
      select: { totalEarnings: true },
      where: { totalEarnings: { gt: 0 } },
      orderBy: { totalEarnings: 'asc' },
    });

    let median = 0;
    if (driversWithEarnings.length > 0) {
      const mid = Math.floor(driversWithEarnings.length / 2);
      median = driversWithEarnings.length % 2 !== 0
        ? Number(driversWithEarnings[mid].totalEarnings)
        : (Number(driversWithEarnings[mid - 1].totalEarnings) + Number(driversWithEarnings[mid].totalEarnings)) / 2;
    }

    return {
      total: Number(aggregates._sum.totalEarnings) || 0,
      avg: Number(aggregates._avg.totalEarnings) || 0,
      median,
    };
  }, CACHE_TTL);
}

async function getDocumentVerificationStats(): Promise<{
  pending: number;
  verified: number;
  rejected: number;
  flagged: number;
  failed: number;
  byType: Array<{ documentType: string; total: number; verified: number; pending: number }>;
}> {
  return withCache(`${CACHE_KEY_PREFIX}documents`, async () => {
    const [byStatus, byType] = await Promise.all([
      prisma.driverDocument.groupBy({
        by: ['verificationStatus'],
        _count: true,
      }),
      prisma.driverDocument.groupBy({
        by: ['documentType', 'verificationStatus'],
        _count: true,
      }),
    ]);

    const result = { pending: 0, verified: 0, rejected: 0, flagged: 0, failed: 0, byType: [] as Array<{ documentType: string; total: number; verified: number; pending: number }> };
    for (const d of byStatus) {
      if (d.verificationStatus === 'verified') result.verified = d._count;
      else if (d.verificationStatus === 'rejected') result.rejected = d._count;
      else if (d.verificationStatus === 'flagged') result.flagged = d._count;
      else if (d.verificationStatus === 'failed') result.failed = d._count;
      else result.pending += d._count;
    }

    const typeMap: Record<string, { total: number; verified: number; pending: number }> = {};
    for (const t of byType) {
      const key = t.documentType;
      if (!typeMap[key]) typeMap[key] = { total: 0, verified: 0, pending: 0 };
      typeMap[key].total += t._count;
      if (t.verificationStatus === 'verified') typeMap[key].verified += t._count;
      else typeMap[key].pending += t._count;
    }
    result.byType = Object.entries(typeMap).map(([documentType, data]) => ({ documentType, ...data }));

    return result;
  }, CACHE_TTL);
}

async function getDriverEarningsFromTable(): Promise<{
  totalGross: number;
  totalCommission: number;
  totalNet: number;
  recordCount: number;
  avgCommissionRate: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}earnings_table`, async () => {
    const agg = await prisma.driverEarning.aggregate({
      _sum: { amount: true, commission: true, netAmount: true },
      _avg: { commissionRate: true },
      _count: true,
    });

    return {
      totalGross: Number(agg._sum.amount) || 0,
      totalCommission: Number(agg._sum.commission) || 0,
      totalNet: Number(agg._sum.netAmount) || 0,
      recordCount: agg._count,
      avgCommissionRate: (Number(agg._avg.commissionRate) || 0) * 100,
    };
  }, CACHE_TTL);
}

async function getDriverPenaltiesStats(): Promise<{
  pendingCount: number;
  pendingAmount: number;
  paidCount: number;
  paidAmount: number;
  totalCount: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}penalties`, async () => {
    const [pending, paid] = await Promise.all([
      prisma.driverPenalty.aggregate({
        where: { status: 'PENDING' },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.driverPenalty.aggregate({
        where: { status: 'PAID' },
        _count: true,
        _sum: { amount: true },
      }),
    ]);

    return {
      pendingCount: pending._count,
      pendingAmount: Number(pending._sum.amount) || 0,
      paidCount: paid._count,
      paidAmount: Number(paid._sum.amount) || 0,
      totalCount: pending._count + paid._count,
    };
  }, CACHE_TTL);
}

function formatMetric(name: string, value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  return `raahi_driver_${name}${labelStr} ${value}`;
}

export async function collectDriverMetrics(): Promise<string> {
  const cachedOutput = metricsCache.get<string>(`${CACHE_KEY_PREFIX}output`);
  
  try {
    const [stats, onboarding, ratingDist, retention, byVehicle, earnings, docs, earningsTable, penalties] = await Promise.all([
      getDriverStats(),
      getDriversByOnboardingStatus(),
      getRatingDistribution(),
      getRetentionStats(),
      getDriversByVehicleType(),
      getEarningsStats(),
      getDocumentVerificationStats(),
      getDriverEarningsFromTable(),
      getDriverPenaltiesStats(),
    ]);

    const lines: string[] = [];

    lines.push('# HELP raahi_driver_total Total number of drivers');
    lines.push('# TYPE raahi_driver_total gauge');
    lines.push(formatMetric('total', stats.total));

    lines.push('# HELP raahi_driver_active Number of active drivers');
    lines.push('# TYPE raahi_driver_active gauge');
    lines.push(formatMetric('active', stats.active));

    lines.push('# HELP raahi_driver_verified Number of verified drivers');
    lines.push('# TYPE raahi_driver_verified gauge');
    lines.push(formatMetric('verified', stats.verified));

    lines.push('# HELP raahi_driver_online Number of currently online drivers');
    lines.push('# TYPE raahi_driver_online gauge');
    lines.push(formatMetric('online', stats.online));

    lines.push('# HELP raahi_driver_avg_rating Average driver rating');
    lines.push('# TYPE raahi_driver_avg_rating gauge');
    lines.push(formatMetric('avg_rating', Math.round(stats.avgRating * 100) / 100));

    lines.push('# HELP raahi_driver_onboarding_status Drivers by onboarding status');
    lines.push('# TYPE raahi_driver_onboarding_status gauge');
    lines.push(formatMetric('onboarding_status', onboarding.pending, { status: 'pending' }));
    lines.push(formatMetric('onboarding_status', onboarding.inProgress, { status: 'in_progress' }));
    lines.push(formatMetric('onboarding_status', onboarding.completed, { status: 'completed' }));
    lines.push(formatMetric('onboarding_status', onboarding.rejected, { status: 'rejected' }));

    lines.push('# HELP raahi_driver_rating_distribution Drivers by rating band');
    lines.push('# TYPE raahi_driver_rating_distribution gauge');
    for (const r of ratingDist) {
      lines.push(formatMetric('rating_distribution', r.count, { band: r.band }));
    }

    lines.push('# HELP raahi_driver_retention_30d 30-day retention rate percentage');
    lines.push('# TYPE raahi_driver_retention_30d gauge');
    lines.push(formatMetric('retention_30d', retention.retentionRate30d));

    lines.push('# HELP raahi_driver_active_30d Drivers active in last 30 days');
    lines.push('# TYPE raahi_driver_active_30d gauge');
    lines.push(formatMetric('active_30d', retention.active30d));

    lines.push('# HELP raahi_driver_active_7d Drivers active in last 7 days');
    lines.push('# TYPE raahi_driver_active_7d gauge');
    lines.push(formatMetric('active_7d', retention.active7d));

    lines.push('# HELP raahi_driver_new_30d New drivers in last 30 days');
    lines.push('# TYPE raahi_driver_new_30d gauge');
    lines.push(formatMetric('new_30d', retention.newDrivers30d));

    lines.push('# HELP raahi_driver_churned_30d Churned drivers in last 30 days');
    lines.push('# TYPE raahi_driver_churned_30d gauge');
    lines.push(formatMetric('churned_30d', retention.churnedDrivers30d));

    lines.push('# HELP raahi_driver_by_vehicle_type Drivers by vehicle type');
    lines.push('# TYPE raahi_driver_by_vehicle_type gauge');
    for (const v of byVehicle) {
      lines.push(formatMetric('by_vehicle_type', v.count, { vehicle_type: v.vehicleType }));
      lines.push(formatMetric('avg_rating_by_vehicle', Math.round(v.avgRating * 100) / 100, { vehicle_type: v.vehicleType }));
    }

    lines.push('# HELP raahi_driver_earnings_total Total earnings across all drivers');
    lines.push('# TYPE raahi_driver_earnings_total gauge');
    lines.push(formatMetric('earnings_total', Math.round(earnings.total * 100) / 100));

    lines.push('# HELP raahi_driver_earnings_avg Average earnings per driver');
    lines.push('# TYPE raahi_driver_earnings_avg gauge');
    lines.push(formatMetric('earnings_avg', Math.round(earnings.avg * 100) / 100));

    lines.push('# HELP raahi_driver_earnings_median Median earnings per driver');
    lines.push('# TYPE raahi_driver_earnings_median gauge');
    lines.push(formatMetric('earnings_median', Math.round(earnings.median * 100) / 100));

    lines.push('# HELP raahi_driver_documents_status Document verification status (from driver_documents table)');
    lines.push('# TYPE raahi_driver_documents_status gauge');
    lines.push(formatMetric('documents_status', docs.pending, { status: 'pending' }));
    lines.push(formatMetric('documents_status', docs.verified, { status: 'verified' }));
    lines.push(formatMetric('documents_status', docs.rejected, { status: 'rejected' }));
    lines.push(formatMetric('documents_status', docs.flagged, { status: 'flagged' }));
    lines.push(formatMetric('documents_status', docs.failed, { status: 'failed' }));

    lines.push('# HELP raahi_driver_documents_by_type Documents by type (LICENSE, RC, INSURANCE, etc.)');
    lines.push('# TYPE raahi_driver_documents_by_type gauge');
    for (const t of docs.byType) {
      lines.push(formatMetric('documents_by_type', t.total, { document_type: t.documentType }));
      lines.push(formatMetric('documents_by_type_verified', t.verified, { document_type: t.documentType }));
      lines.push(formatMetric('documents_by_type_pending', t.pending, { document_type: t.documentType }));
    }

    lines.push('# HELP raahi_driver_earnings_commission_total Total platform commission from driver_earnings');
    lines.push('# TYPE raahi_driver_earnings_commission_total gauge');
    lines.push(formatMetric('earnings_commission_total', Math.round(earningsTable.totalCommission * 100) / 100));

    lines.push('# HELP raahi_driver_earnings_net_total Total net payouts to drivers from driver_earnings');
    lines.push('# TYPE raahi_driver_earnings_net_total gauge');
    lines.push(formatMetric('earnings_net_total', Math.round(earningsTable.totalNet * 100) / 100));

    lines.push('# HELP raahi_driver_earnings_record_count Number of driver_earnings records');
    lines.push('# TYPE raahi_driver_earnings_record_count gauge');
    lines.push(formatMetric('earnings_record_count', earningsTable.recordCount));

    lines.push('# HELP raahi_driver_penalties_pending_count Pending penalties from driver_penalties');
    lines.push('# TYPE raahi_driver_penalties_pending_count gauge');
    lines.push(formatMetric('penalties_pending_count', penalties.pendingCount));

    lines.push('# HELP raahi_driver_penalties_pending_amount Pending penalty amount in INR');
    lines.push('# TYPE raahi_driver_penalties_pending_amount gauge');
    lines.push(formatMetric('penalties_pending_amount', Math.round(penalties.pendingAmount * 100) / 100));

    lines.push('# HELP raahi_driver_penalties_paid_count Paid penalties');
    lines.push('# TYPE raahi_driver_penalties_paid_count gauge');
    lines.push(formatMetric('penalties_paid_count', penalties.paidCount));

    lines.push('# HELP raahi_driver_verification_rate Percentage of verified drivers');
    lines.push('# TYPE raahi_driver_verification_rate gauge');
    const verificationRate = stats.total > 0 ? (stats.verified / stats.total) * 100 : 0;
    lines.push(formatMetric('verification_rate', Math.round(verificationRate * 100) / 100));

    lines.push('# HELP raahi_driver_utilization_rate Percentage of active drivers who are online');
    lines.push('# TYPE raahi_driver_utilization_rate gauge');
    const utilizationRate = stats.active > 0 ? (stats.online / stats.active) * 100 : 0;
    lines.push(formatMetric('utilization_rate', Math.round(utilizationRate * 100) / 100));

    const output = lines.join('\n');
    metricsCache.set(`${CACHE_KEY_PREFIX}output`, output, CACHE_TTL);
    return output;

  } catch (error) {
    logger.error('[DRIVER_METRICS] Collection failed:', error);
    if (cachedOutput) {
      logger.warn('[DRIVER_METRICS] Serving stale cached metrics');
      return cachedOutput + '\n# WARNING: Serving stale metrics due to DB error';
    }
    throw error;
  }
}
