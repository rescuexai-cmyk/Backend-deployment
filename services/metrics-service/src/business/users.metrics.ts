/**
 * User Metrics Collector
 * Based on Raahi Platform User KPI queries
 * Adapted to Prisma schema (users table)
 */

import { prisma, logger } from '@raahi/shared';
import { withCache, metricsCache } from './metrics.cache';

const CACHE_TTL = 60000;
const CACHE_KEY_PREFIX = 'user_metrics_';

function formatMetric(name: string, value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  return `raahi_user_${name}${labelStr} ${value}`;
}

async function getUserSummary(): Promise<{
  total: number;
  active: number;
  inactive: number;
  verified: number;
  unverified: number;
  activePercentage: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}summary`, async () => {
    const [total, active, verified] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { isVerified: true } }),
    ]);
    const inactive = total - active;
    const unverified = total - verified;
    const activePercentage = total > 0 ? (active / total) * 100 : 0;
    return { total, active, inactive, verified, unverified, activePercentage };
  }, CACHE_TTL);
}

async function getRegistrationTrend(): Promise<{ newToday: number; new7d: number; new30d: number }> {
  return withCache(`${CACHE_KEY_PREFIX}registration`, async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [newToday, new7d, new30d] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    ]);

    return { newToday, new7d, new30d };
  }, CACHE_TTL);
}

async function getActiveUsers(): Promise<{
  active7d: number;
  active30d: number;
  mauPercentage: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}active`, async () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [active7d, active30d, totalActive] = await Promise.all([
      prisma.user.count({
        where: { isActive: true, lastLoginAt: { gte: sevenDaysAgo } },
      }),
      prisma.user.count({
        where: { isActive: true, lastLoginAt: { gte: thirtyDaysAgo } },
      }),
      prisma.user.count({ where: { isActive: true } }),
    ]);

    const mauPercentage = totalActive > 0 ? (active30d / totalActive) * 100 : 0;
    return { active7d, active30d, mauPercentage };
  }, CACHE_TTL);
}

async function getConversionStats(): Promise<{
  totalActiveUsers: number;
  usersWithRides: number;
  conversionRate: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}conversion`, async () => {
    const totalActiveUsers = await prisma.user.count({ where: { isActive: true } });
    const usersWithRides = await prisma.ride.groupBy({
      by: ['passengerId'],
      where: { status: 'RIDE_COMPLETED' },
      _count: true,
    });
    const uniqueUsersWithRides = usersWithRides.length;
    const conversionRate = totalActiveUsers > 0 ? (uniqueUsersWithRides / totalActiveUsers) * 100 : 0;
    return { totalActiveUsers, usersWithRides: uniqueUsersWithRides, conversionRate };
  }, CACHE_TTL);
}

async function getDevicePlatformDistribution(): Promise<Array<{ platform: string; count: number }>> {
  return withCache(`${CACHE_KEY_PREFIX}device`, async () => {
    const groups = await prisma.user.groupBy({
      by: ['devicePlatform'],
      _count: true,
      where: { isActive: true },
    });

    const result: Array<{ platform: string; count: number }> = [];
    for (const g of groups) {
      result.push({ platform: g.devicePlatform || 'unknown', count: g._count });
    }
    return result;
  }, CACHE_TTL);
}

async function getChurnStats(): Promise<{
  totalActive: number;
  potentiallyChurned: number;
  churnRiskPercentage: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}churn`, async () => {
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const totalActive = await prisma.user.count({ where: { isActive: true } });
    const withOldLogin = await prisma.user.count({
      where: { isActive: true, lastLoginAt: { lt: sixtyDaysAgo } },
    });
    const withNullLogin = await prisma.user.count({
      where: { isActive: true, lastLoginAt: { equals: null } },
    });
    const potentiallyChurned = withOldLogin + withNullLogin;

    const churnRiskPercentage = totalActive > 0 ? (potentiallyChurned / totalActive) * 100 : 0;
    return { totalActive, potentiallyChurned, churnRiskPercentage };
  }, CACHE_TTL);
}

async function getUsersWithEmail(): Promise<{ withEmail: number; withoutEmail: number }> {
  return withCache(`${CACHE_KEY_PREFIX}email`, async () => {
    const [withEmail, total] = await Promise.all([
      prisma.user.count({ where: { email: { not: null } } }),
      prisma.user.count(),
    ]);
    return { withEmail, withoutEmail: total - withEmail };
  }, CACHE_TTL);
}

async function getVerificationStats(): Promise<{
  verified: number;
  unverified: number;
  verifiedPercentage: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}verification`, async () => {
    const [verified, total] = await Promise.all([
      prisma.user.count({ where: { isVerified: true } }),
      prisma.user.count(),
    ]);
    const unverified = total - verified;
    const verifiedPercentage = total > 0 ? (verified / total) * 100 : 0;
    return { verified, unverified, verifiedPercentage };
  }, CACHE_TTL);
}

async function getRideFrequencyBands(): Promise<Array<{ band: string; userCount: number }>> {
  return withCache(`${CACHE_KEY_PREFIX}ride_freq`, async () => {
    const userRideCounts = await prisma.ride.groupBy({
      by: ['passengerId'],
      where: { status: 'RIDE_COMPLETED' },
      _count: true,
    });

    const bands: Record<string, number> = {
      '1_ride': 0,
      '2_5_rides': 0,
      '6_10_rides': 0,
      '11_20_rides': 0,
      '20_plus_rides': 0,
    };

    for (const u of userRideCounts) {
      const count = u._count;
      if (count === 1) bands['1_ride']++;
      else if (count <= 5) bands['2_5_rides']++;
      else if (count <= 10) bands['6_10_rides']++;
      else if (count <= 20) bands['11_20_rides']++;
      else bands['20_plus_rides']++;
    }

    return Object.entries(bands).map(([band, userCount]) => ({ band, userCount }));
  }, CACHE_TTL);
}

export async function collectUserMetrics(): Promise<string> {
  const cachedOutput = metricsCache.get<string>(`${CACHE_KEY_PREFIX}output`);

  try {
    const [
      summary,
      registration,
      activeUsers,
      conversion,
      deviceDist,
      churn,
      emailStats,
      verification,
      rideFreq,
    ] = await Promise.all([
      getUserSummary(),
      getRegistrationTrend(),
      getActiveUsers(),
      getConversionStats(),
      getDevicePlatformDistribution(),
      getChurnStats(),
      getUsersWithEmail(),
      getVerificationStats(),
      getRideFrequencyBands(),
    ]);

    const lines: string[] = [];

    lines.push('# HELP raahi_user_total Total number of users');
    lines.push('# TYPE raahi_user_total gauge');
    lines.push(formatMetric('total', summary.total));

    lines.push('# HELP raahi_user_active Active users (isActive=true)');
    lines.push('# TYPE raahi_user_active gauge');
    lines.push(formatMetric('active', summary.active));

    lines.push('# HELP raahi_user_inactive Inactive users');
    lines.push('# TYPE raahi_user_inactive gauge');
    lines.push(formatMetric('inactive', summary.inactive));

    lines.push('# HELP raahi_user_verified Verified users');
    lines.push('# TYPE raahi_user_verified gauge');
    lines.push(formatMetric('verified', summary.verified));

    lines.push('# HELP raahi_user_unverified Unverified users');
    lines.push('# TYPE raahi_user_unverified gauge');
    lines.push(formatMetric('unverified', summary.unverified));

    lines.push('# HELP raahi_user_active_percentage Active user percentage');
    lines.push('# TYPE raahi_user_active_percentage gauge');
    lines.push(formatMetric('active_percentage', Math.round(summary.activePercentage * 100) / 100));

    lines.push('# HELP raahi_user_verified_percentage Verified user percentage');
    lines.push('# TYPE raahi_user_verified_percentage gauge');
    lines.push(formatMetric('verified_percentage', Math.round(verification.verifiedPercentage * 100) / 100));

    lines.push('# HELP raahi_user_new_today New users registered today');
    lines.push('# TYPE raahi_user_new_today gauge');
    lines.push(formatMetric('new_today', registration.newToday));

    lines.push('# HELP raahi_user_new_7d New users in last 7 days');
    lines.push('# TYPE raahi_user_new_7d gauge');
    lines.push(formatMetric('new_7d', registration.new7d));

    lines.push('# HELP raahi_user_new_30d New users in last 30 days');
    lines.push('# TYPE raahi_user_new_30d gauge');
    lines.push(formatMetric('new_30d', registration.new30d));

    lines.push('# HELP raahi_user_active_7d Users with login in last 7 days');
    lines.push('# TYPE raahi_user_active_7d gauge');
    lines.push(formatMetric('active_7d', activeUsers.active7d));

    lines.push('# HELP raahi_user_active_30d Users with login in last 30 days (MAU)');
    lines.push('# TYPE raahi_user_active_30d gauge');
    lines.push(formatMetric('active_30d', activeUsers.active30d));

    lines.push('# HELP raahi_user_mau_percentage MAU as percentage of active users');
    lines.push('# TYPE raahi_user_mau_percentage gauge');
    lines.push(formatMetric('mau_percentage', Math.round(activeUsers.mauPercentage * 100) / 100));

    lines.push('# HELP raahi_user_conversion_total Active users who have completed at least one ride');
    lines.push('# TYPE raahi_user_conversion_total gauge');
    lines.push(formatMetric('conversion_users_with_rides', conversion.usersWithRides));

    lines.push('# HELP raahi_user_conversion_rate Conversion rate percentage');
    lines.push('# TYPE raahi_user_conversion_rate gauge');
    lines.push(formatMetric('conversion_rate', Math.round(conversion.conversionRate * 100) / 100));

    lines.push('# HELP raahi_user_by_device_platform Users by device platform');
    lines.push('# TYPE raahi_user_by_device_platform gauge');
    for (const d of deviceDist) {
      lines.push(formatMetric('by_device_platform', d.count, { platform: d.platform }));
    }

    lines.push('# HELP raahi_user_churn_risk Potentially churned users (no login 60+ days)');
    lines.push('# TYPE raahi_user_churn_risk gauge');
    lines.push(formatMetric('churn_risk_count', churn.potentiallyChurned));

    lines.push('# HELP raahi_user_churn_risk_percentage Churn risk percentage');
    lines.push('# TYPE raahi_user_churn_risk_percentage gauge');
    lines.push(formatMetric('churn_risk_percentage', Math.round(churn.churnRiskPercentage * 100) / 100));

    lines.push('# HELP raahi_user_with_email Users with email set');
    lines.push('# TYPE raahi_user_with_email gauge');
    lines.push(formatMetric('with_email', emailStats.withEmail));

    lines.push('# HELP raahi_user_ride_frequency Users by ride count band');
    lines.push('# TYPE raahi_user_ride_frequency gauge');
    for (const r of rideFreq) {
      lines.push(formatMetric('ride_frequency', r.userCount, { band: r.band }));
    }

    const output = lines.join('\n');
    metricsCache.set(`${CACHE_KEY_PREFIX}output`, output, CACHE_TTL);
    return output;
  } catch (error) {
    logger.error('[USER_METRICS] Collection failed:', error);
    if (cachedOutput) {
      logger.warn('[USER_METRICS] Serving stale cached metrics');
      return cachedOutput + '\n# WARNING: Serving stale user metrics due to DB error';
    }
    throw error;
  }
}
