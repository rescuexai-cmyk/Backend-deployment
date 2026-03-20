/**
 * Ride Metrics Collector
 * Based on Raahi Platform Ride KPI queries
 * Adapted to Prisma schema (rides table)
 */

import { prisma, logger } from '@raahi/shared';
import { withCache, metricsCache } from './metrics.cache';

const CACHE_TTL = 60000;
const CACHE_KEY_PREFIX = 'ride_metrics_';

function formatMetric(name: string, value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  return `raahi_ride_${name}${labelStr} ${value}`;
}

async function getRideSummary(): Promise<{
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  cancelled: number;
  completionRate: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}summary`, async () => {
    const [total, completed, inProgress, pending, cancelled] = await Promise.all([
      prisma.ride.count(),
      prisma.ride.count({ where: { status: 'RIDE_COMPLETED' } }),
      prisma.ride.count({
        where: {
          status: { in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'RIDE_STARTED'] },
        },
      }),
      prisma.ride.count({
        where: { status: { in: ['PENDING', 'CONFIRMED'] } },
      }),
      prisma.ride.count({ where: { status: 'CANCELLED' } }),
    ]);

    const completionRate = total > 0 ? (completed / total) * 100 : 0;
    return { total, completed, inProgress, pending, cancelled, completionRate };
  }, CACHE_TTL);
}

async function getRidesByStatus(): Promise<Array<{ status: string; count: number }>> {
  return withCache(`${CACHE_KEY_PREFIX}by_status`, async () => {
    const groups = await prisma.ride.groupBy({
      by: ['status'],
      _count: true,
    });
    return groups.map((g) => ({ status: g.status, count: g._count }));
  }, CACHE_TTL);
}

async function getRidesByVehicleType(): Promise<Array<{ vehicleType: string; count: number; completed: number; avgFare: number }>> {
  return withCache(`${CACHE_KEY_PREFIX}by_vehicle`, async () => {
    const ridesWithDriver = await prisma.ride.findMany({
      where: { driverId: { not: null } },
      select: {
        totalFare: true,
        status: true,
        driver: { select: { vehicleType: true } },
      },
    });

    const byVehicle: Record<string, { count: number; completed: number; totalFare: number }> = {};
    for (const r of ridesWithDriver) {
      const vt = r.driver?.vehicleType || 'unknown';
      if (!byVehicle[vt]) byVehicle[vt] = { count: 0, completed: 0, totalFare: 0 };
      byVehicle[vt].count++;
      if (r.status === 'RIDE_COMPLETED') {
        byVehicle[vt].completed++;
        byVehicle[vt].totalFare += Number(r.totalFare);
      }
    }

    return Object.entries(byVehicle).map(([vehicleType, data]) => ({
      vehicleType,
      count: data.count,
      completed: data.completed,
      avgFare: data.completed > 0 ? data.totalFare / data.completed : 0,
    }));
  }, CACHE_TTL);
}

async function getAvgRideMetrics(): Promise<{
  avgDistanceKm: number;
  avgDurationMin: number;
  avgFare: number;
  avgSurge: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}avg`, async () => {
    const agg = await prisma.ride.aggregate({
      where: { status: 'RIDE_COMPLETED' },
      _avg: {
        distance: true,
        duration: true,
        totalFare: true,
        surgeMultiplier: true,
      },
    });

    return {
      avgDistanceKm: Number(agg._avg.distance) || 0,
      avgDurationMin: Number(agg._avg.duration) || 0,
      avgFare: Number(agg._avg.totalFare) || 0,
      avgSurge: Number(agg._avg.surgeMultiplier) || 0,
    };
  }, CACHE_TTL);
}

async function getRatingStats(): Promise<{
  avgPassengerRating: number;
  avgDriverRating: number;
  ratedCount: number;
  excellentCount: number;
  poorCount: number;
  ratingRate: number;
}> {
  return withCache(`${CACHE_KEY_PREFIX}ratings`, async () => {
    const completed = await prisma.ride.count({
      where: { status: 'RIDE_COMPLETED' },
    });
    const withRating = await prisma.ride.count({
      where: { status: 'RIDE_COMPLETED', passengerRating: { not: null } },
    });
    const excellent = await prisma.ride.count({
      where: { status: 'RIDE_COMPLETED', passengerRating: { gte: 4.5 } },
    });
    const poor = await prisma.ride.count({
      where: { status: 'RIDE_COMPLETED', passengerRating: { lt: 3 } },
    });

    const agg = await prisma.ride.aggregate({
      where: { status: 'RIDE_COMPLETED', passengerRating: { not: null } },
      _avg: { passengerRating: true, driverRating: true },
    });

    return {
      avgPassengerRating: Number(agg._avg.passengerRating) || 0,
      avgDriverRating: Number(agg._avg.driverRating) || 0,
      ratedCount: withRating,
      excellentCount: excellent,
      poorCount: poor,
      ratingRate: completed > 0 ? (withRating / completed) * 100 : 0,
    };
  }, CACHE_TTL);
}

async function getCancellationStats(): Promise<{
  totalCancelled: number;
  byReason: Array<{ reason: string; count: number }>;
}> {
  return withCache(`${CACHE_KEY_PREFIX}cancellations`, async () => {
    const cancelled = await prisma.ride.count({ where: { status: 'CANCELLED' } });
    const byReason = await prisma.ride.groupBy({
      by: ['cancellationReason'],
      _count: true,
      where: { status: 'CANCELLED' },
    });

    return {
      totalCancelled: cancelled,
      byReason: byReason.map((r) => ({
        reason: r.cancellationReason || 'unknown',
        count: r._count,
      })),
    };
  }, CACHE_TTL);
}

async function getPeakHours(): Promise<Array<{ hour: number; count: number; completed: number; avgFare: number }>> {
  return withCache(`${CACHE_KEY_PREFIX}peak_hours`, async () => {
    const result = await prisma.$queryRaw<Array<{ hour: number; total_rides: bigint; completed: bigint; avg_fare: number }>>`
      SELECT 
        EXTRACT(HOUR FROM "createdAt")::int AS hour,
        COUNT(*)::bigint AS total_rides,
        COUNT(*) FILTER (WHERE status = 'RIDE_COMPLETED')::bigint AS completed,
        COALESCE(ROUND(AVG("totalFare") FILTER (WHERE status = 'RIDE_COMPLETED')::numeric, 2), 0) AS avg_fare
      FROM rides
      GROUP BY EXTRACT(HOUR FROM "createdAt")
      ORDER BY hour
    `;

    return result.map((r) => ({
      hour: r.hour,
      count: Number(r.total_rides),
      completed: Number(r.completed),
      avgFare: Number(r.avg_fare),
    }));
  }, CACHE_TTL);
}

async function getDurationDistribution(): Promise<Array<{ band: string; count: number }>> {
  return withCache(`${CACHE_KEY_PREFIX}duration_dist`, async () => {
    const result = await prisma.$queryRaw<Array<{ band: string; ride_count: bigint }>>`
      SELECT 
        CASE 
          WHEN duration < 10 THEN 'under_10_min'
          WHEN duration < 20 THEN '10_20_min'
          WHEN duration < 30 THEN '20_30_min'
          WHEN duration < 45 THEN '30_45_min'
          WHEN duration < 60 THEN '45_60_min'
          ELSE 'over_60_min'
        END AS band,
        COUNT(*)::bigint AS ride_count
      FROM rides
      WHERE status = 'RIDE_COMPLETED'
      GROUP BY 
        CASE 
          WHEN duration < 10 THEN 'under_10_min'
          WHEN duration < 20 THEN '10_20_min'
          WHEN duration < 30 THEN '20_30_min'
          WHEN duration < 45 THEN '30_45_min'
          WHEN duration < 60 THEN '45_60_min'
          ELSE 'over_60_min'
        END
      ORDER BY MIN(duration)
    `;

    return result.map((r) => ({ band: r.band, count: Number(r.ride_count) }));
  }, CACHE_TTL);
}

async function getDistanceDistribution(): Promise<Array<{ band: string; count: number }>> {
  return withCache(`${CACHE_KEY_PREFIX}distance_dist`, async () => {
    const result = await prisma.$queryRaw<Array<{ band: string; ride_count: bigint }>>`
      SELECT 
        CASE 
          WHEN distance < 3 THEN 'under_3_km'
          WHEN distance < 5 THEN '3_5_km'
          WHEN distance < 10 THEN '5_10_km'
          WHEN distance < 15 THEN '10_15_km'
          WHEN distance < 20 THEN '15_20_km'
          ELSE 'over_20_km'
        END AS band,
        COUNT(*)::bigint AS ride_count
      FROM rides
      WHERE status = 'RIDE_COMPLETED'
      GROUP BY 
        CASE 
          WHEN distance < 3 THEN 'under_3_km'
          WHEN distance < 5 THEN '3_5_km'
          WHEN distance < 10 THEN '5_10_km'
          WHEN distance < 15 THEN '10_15_km'
          WHEN distance < 20 THEN '15_20_km'
          ELSE 'over_20_km'
        END
      ORDER BY MIN(distance)
    `;

    return result.map((r) => ({ band: r.band, count: Number(r.ride_count) }));
  }, CACHE_TTL);
}

async function getDailyTrend(): Promise<{ completedToday: number; cancelledToday: number; newToday: number }> {
  return withCache(`${CACHE_KEY_PREFIX}daily`, async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [completedToday, cancelledToday, newToday] = await Promise.all([
      prisma.ride.count({
        where: { status: 'RIDE_COMPLETED', completedAt: { gte: today } },
      }),
      prisma.ride.count({
        where: { status: 'CANCELLED', cancelledAt: { gte: today } },
      }),
      prisma.ride.count({
        where: { createdAt: { gte: today } },
      }),
    ]);

    return { completedToday, cancelledToday, newToday };
  }, CACHE_TTL);
}

async function getLast30DaysStats(): Promise<{ completed30d: number; new30d: number; cancelled30d: number }> {
  return withCache(`${CACHE_KEY_PREFIX}30d`, async () => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const [completed30d, new30d, cancelled30d] = await Promise.all([
      prisma.ride.count({
        where: { status: 'RIDE_COMPLETED', completedAt: { gte: thirtyDaysAgo } },
      }),
      prisma.ride.count({
        where: { createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.ride.count({
        where: { status: 'CANCELLED', cancelledAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    return { completed30d, new30d, cancelled30d };
  }, CACHE_TTL);
}

export async function collectRideMetrics(): Promise<string> {
  const cachedOutput = metricsCache.get<string>(`${CACHE_KEY_PREFIX}output`);

  try {
    const [
      summary,
      byStatus,
      byVehicle,
      avgMetrics,
      ratingStats,
      cancelStats,
      peakHours,
      durationDist,
      distanceDist,
      dailyTrend,
      last30d,
    ] = await Promise.all([
      getRideSummary(),
      getRidesByStatus(),
      getRidesByVehicleType(),
      getAvgRideMetrics(),
      getRatingStats(),
      getCancellationStats(),
      getPeakHours(),
      getDurationDistribution(),
      getDistanceDistribution(),
      getDailyTrend(),
      getLast30DaysStats(),
    ]);

    const lines: string[] = [];

    lines.push('# HELP raahi_ride_total Total number of rides');
    lines.push('# TYPE raahi_ride_total gauge');
    lines.push(formatMetric('total', summary.total));

    lines.push('# HELP raahi_ride_completed Total completed rides');
    lines.push('# TYPE raahi_ride_completed gauge');
    lines.push(formatMetric('completed', summary.completed));

    lines.push('# HELP raahi_ride_in_progress Rides currently in progress');
    lines.push('# TYPE raahi_ride_in_progress gauge');
    lines.push(formatMetric('in_progress', summary.inProgress));

    lines.push('# HELP raahi_ride_pending Pending/requested rides');
    lines.push('# TYPE raahi_ride_pending gauge');
    lines.push(formatMetric('pending', summary.pending));

    lines.push('# HELP raahi_ride_cancelled Total cancelled rides');
    lines.push('# TYPE raahi_ride_cancelled gauge');
    lines.push(formatMetric('cancelled', summary.cancelled));

    lines.push('# HELP raahi_ride_completion_rate Completion rate percentage');
    lines.push('# TYPE raahi_ride_completion_rate gauge');
    lines.push(formatMetric('completion_rate', Math.round(summary.completionRate * 100) / 100));

    lines.push('# HELP raahi_ride_by_status Rides by status');
    lines.push('# TYPE raahi_ride_by_status gauge');
    for (const s of byStatus) {
      lines.push(formatMetric('by_status', s.count, { status: s.status }));
    }

    lines.push('# HELP raahi_ride_by_vehicle_type Rides by vehicle type');
    lines.push('# TYPE raahi_ride_by_vehicle_type gauge');
    for (const v of byVehicle) {
      lines.push(formatMetric('by_vehicle_type', v.count, { vehicle_type: v.vehicleType }));
      lines.push(formatMetric('completed_by_vehicle', v.completed, { vehicle_type: v.vehicleType }));
      lines.push(formatMetric('avg_fare_by_vehicle', Math.round(v.avgFare * 100) / 100, { vehicle_type: v.vehicleType }));
    }

    lines.push('# HELP raahi_ride_avg_distance_km Average ride distance');
    lines.push('# TYPE raahi_ride_avg_distance_km gauge');
    lines.push(formatMetric('avg_distance_km', Math.round(avgMetrics.avgDistanceKm * 100) / 100));

    lines.push('# HELP raahi_ride_avg_duration_min Average ride duration in minutes');
    lines.push('# TYPE raahi_ride_avg_duration_min gauge');
    lines.push(formatMetric('avg_duration_min', avgMetrics.avgDurationMin));

    lines.push('# HELP raahi_ride_avg_fare Average fare');
    lines.push('# TYPE raahi_ride_avg_fare gauge');
    lines.push(formatMetric('avg_fare', Math.round(avgMetrics.avgFare * 100) / 100));

    lines.push('# HELP raahi_ride_avg_surge Average surge multiplier');
    lines.push('# TYPE raahi_ride_avg_surge gauge');
    lines.push(formatMetric('avg_surge', Math.round(avgMetrics.avgSurge * 100) / 100));

    lines.push('# HELP raahi_ride_avg_passenger_rating Average passenger rating');
    lines.push('# TYPE raahi_ride_avg_passenger_rating gauge');
    lines.push(formatMetric('avg_passenger_rating', Math.round(ratingStats.avgPassengerRating * 100) / 100));

    lines.push('# HELP raahi_ride_rated_count Rides with passenger rating');
    lines.push('# TYPE raahi_ride_rated_count gauge');
    lines.push(formatMetric('rated_count', ratingStats.ratedCount));

    lines.push('# HELP raahi_ride_rating_submission_rate Rating submission rate percentage');
    lines.push('# TYPE raahi_ride_rating_submission_rate gauge');
    lines.push(formatMetric('rating_submission_rate', Math.round(ratingStats.ratingRate * 100) / 100));

    lines.push('# HELP raahi_ride_excellent_ratings Rides with rating >= 4.5');
    lines.push('# TYPE raahi_ride_excellent_ratings gauge');
    lines.push(formatMetric('excellent_ratings', ratingStats.excellentCount));

    lines.push('# HELP raahi_ride_poor_ratings Rides with rating < 3');
    lines.push('# TYPE raahi_ride_poor_ratings gauge');
    lines.push(formatMetric('poor_ratings', ratingStats.poorCount));

    lines.push('# HELP raahi_ride_cancelled_total Total cancelled rides');
    lines.push('# TYPE raahi_ride_cancelled_total gauge');
    lines.push(formatMetric('cancelled_total', cancelStats.totalCancelled));

    lines.push('# HELP raahi_ride_cancelled_by_reason Cancelled rides by reason');
    lines.push('# TYPE raahi_ride_cancelled_by_reason gauge');
    for (const r of cancelStats.byReason) {
      const safeReason = r.reason.replace(/"/g, "'").slice(0, 50);
      lines.push(formatMetric('cancelled_by_reason', r.count, { reason: safeReason }));
    }

    lines.push('# HELP raahi_ride_peak_hour_count Rides by hour of day');
    lines.push('# TYPE raahi_ride_peak_hour_count gauge');
    for (const p of peakHours) {
      lines.push(formatMetric('peak_hour_count', p.count, { hour: String(p.hour) }));
      lines.push(formatMetric('peak_hour_completed', p.completed, { hour: String(p.hour) }));
    }

    lines.push('# HELP raahi_ride_duration_distribution Rides by duration band');
    lines.push('# TYPE raahi_ride_duration_distribution gauge');
    for (const d of durationDist) {
      lines.push(formatMetric('duration_distribution', d.count, { band: d.band }));
    }

    lines.push('# HELP raahi_ride_distance_distribution Rides by distance band');
    lines.push('# TYPE raahi_ride_distance_distribution gauge');
    for (const d of distanceDist) {
      lines.push(formatMetric('distance_distribution', d.count, { band: d.band }));
    }

    lines.push('# HELP raahi_ride_completed_today Rides completed today');
    lines.push('# TYPE raahi_ride_completed_today gauge');
    lines.push(formatMetric('completed_today', dailyTrend.completedToday));

    lines.push('# HELP raahi_ride_cancelled_today Rides cancelled today');
    lines.push('# TYPE raahi_ride_cancelled_today gauge');
    lines.push(formatMetric('cancelled_today', dailyTrend.cancelledToday));

    lines.push('# HELP raahi_ride_new_today New rides requested today');
    lines.push('# TYPE raahi_ride_new_today gauge');
    lines.push(formatMetric('new_today', dailyTrend.newToday));

    lines.push('# HELP raahi_ride_completed_30d Completed rides in last 30 days');
    lines.push('# TYPE raahi_ride_completed_30d gauge');
    lines.push(formatMetric('completed_30d', last30d.completed30d));

    lines.push('# HELP raahi_ride_new_30d New rides in last 30 days');
    lines.push('# TYPE raahi_ride_new_30d gauge');
    lines.push(formatMetric('new_30d', last30d.new30d));

    lines.push('# HELP raahi_ride_cancelled_30d Cancelled rides in last 30 days');
    lines.push('# TYPE raahi_ride_cancelled_30d gauge');
    lines.push(formatMetric('cancelled_30d', last30d.cancelled30d));

    const cancellationRate = summary.total > 0 ? (summary.cancelled / summary.total) * 100 : 0;
    lines.push('# HELP raahi_ride_cancellation_rate Cancellation rate percentage');
    lines.push('# TYPE raahi_ride_cancellation_rate gauge');
    lines.push(formatMetric('cancellation_rate', Math.round(cancellationRate * 100) / 100));

    const output = lines.join('\n');
    metricsCache.set(`${CACHE_KEY_PREFIX}output`, output, CACHE_TTL);
    return output;
  } catch (error) {
    logger.error('[RIDE_METRICS] Collection failed:', error);
    if (cachedOutput) {
      logger.warn('[RIDE_METRICS] Serving stale cached metrics');
      return cachedOutput + '\n# WARNING: Serving stale ride metrics due to DB error';
    }
    throw error;
  }
}
