import { prisma } from '@raahi/shared';

export type MarketplaceMode = 'launch' | 'scale';

export type MarketplacePolicy = {
  cityCode: string;
  marketplaceMode: MarketplaceMode;
  launchSubsidyPct: number;
  launchSubsidyCap: number;
  burnCap: number;
  contributionFloor: number;
  etaTargetMin: number;
  supplyThreshold: number;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

const DEFAULT_POLICY: Omit<MarketplacePolicy, 'cityCode'> = {
  marketplaceMode: 'scale',
  launchSubsidyPct: 0.25,
  launchSubsidyCap: 80,
  burnCap: 0.22,
  contributionFloor: -40,
  etaTargetMin: 8,
  supplyThreshold: 0.9,
  isActive: true,
};

export type ZoneRealtimeSnapshot = {
  fulfillment: number;
  acceptRate: number;
  etaP90: number;
  supplyRate: number;
  zoneHealth: number;
};

export type PricingV2Outcome = {
  riderFare: number;
  riderSubsidy: number;
  driverBoost: number;
  questIncentive: number;
  burnRate: number;
  contribution: number;
  surgeSensitivity: number;
  liquidityActions: string[];
  effectiveSubsidyPct: number;
  guarantee: {
    enabled: boolean;
    hourlyAmount: number;
  };
  driverTripFloor: number;
  questPlan: {
    milestones: Array<{ rides: number; payout: number }>;
    perRidePeakBonus: number;
  };
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function boostForVehicle(vehicleType: string): number {
  const v = vehicleType.toLowerCase();
  if (v.includes('bike')) return 15;
  if (v === 'auto') return 20;
  return 30;
}

export async function getMarketplacePolicy(cityCode: string): Promise<MarketplacePolicy> {
  const db = prisma as any;
  const row = await db.pricingCityPolicy?.findUnique({
    where: { cityCode },
  });

  if (!row) {
    return { cityCode, ...DEFAULT_POLICY };
  }

  return {
    cityCode,
    marketplaceMode: row.marketplaceMode === 'launch' ? 'launch' : 'scale',
    launchSubsidyPct: row.launchSubsidyPct,
    launchSubsidyCap: row.launchSubsidyCap,
    burnCap: row.burnCap,
    contributionFloor: row.contributionFloor,
    etaTargetMin: row.etaTargetMin,
    supplyThreshold: row.supplyThreshold,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertMarketplacePolicy(input: Partial<MarketplacePolicy> & { cityCode: string }): Promise<MarketplacePolicy> {
  const db = prisma as any;
  const current = await getMarketplacePolicy(input.cityCode);
  const payload = {
    cityCode: input.cityCode,
    marketplaceMode: input.marketplaceMode ?? current.marketplaceMode,
    launchSubsidyPct: input.launchSubsidyPct ?? current.launchSubsidyPct,
    launchSubsidyCap: input.launchSubsidyCap ?? current.launchSubsidyCap,
    burnCap: input.burnCap ?? current.burnCap,
    contributionFloor: input.contributionFloor ?? current.contributionFloor,
    etaTargetMin: input.etaTargetMin ?? current.etaTargetMin,
    supplyThreshold: input.supplyThreshold ?? current.supplyThreshold,
    isActive: input.isActive ?? current.isActive,
  };

  const row = await db.pricingCityPolicy?.upsert({
    where: { cityCode: input.cityCode },
    update: payload,
    create: payload,
  });

  if (!row) return { ...payload };
  return {
    cityCode: row.cityCode,
    marketplaceMode: row.marketplaceMode === 'launch' ? 'launch' : 'scale',
    launchSubsidyPct: row.launchSubsidyPct,
    launchSubsidyCap: row.launchSubsidyCap,
    burnCap: row.burnCap,
    contributionFloor: row.contributionFloor,
    etaTargetMin: row.etaTargetMin,
    supplyThreshold: row.supplyThreshold,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCurrentBurnRate(cityCode: string): Promise<number> {
  const db = prisma as any;
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const metric = await db.pricingBurnMetric?.findUnique({
    where: { cityCode_date: { cityCode, date: dayStart } },
  });
  return metric?.burnRate ?? 0;
}

export async function recordBurnMetricDelta(params: {
  cityCode: string;
  gmvDelta: number;
  subsidyDelta: number;
  incentivesDelta: number;
}) {
  const db = prisma as any;
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const existing = await db.pricingBurnMetric?.findUnique({
    where: { cityCode_date: { cityCode: params.cityCode, date: dayStart } },
  });

  const nextGmv = (existing?.gmv ?? 0) + Math.max(0, params.gmvDelta);
  const nextSubsidy = (existing?.subsidy ?? 0) + Math.max(0, params.subsidyDelta);
  const nextIncentives = (existing?.incentives ?? 0) + Math.max(0, params.incentivesDelta);
  const nextBurnRate = nextGmv > 0 ? (nextSubsidy + nextIncentives) / nextGmv : 0;

  await db.pricingBurnMetric?.upsert({
    where: { cityCode_date: { cityCode: params.cityCode, date: dayStart } },
    update: {
      gmv: nextGmv,
      subsidy: nextSubsidy,
      incentives: nextIncentives,
      burnRate: nextBurnRate,
    },
    create: {
      cityCode: params.cityCode,
      date: dayStart,
      gmv: nextGmv,
      subsidy: nextSubsidy,
      incentives: nextIncentives,
      burnRate: nextBurnRate,
    },
  });
}

export function applyPricingPolicyV2(params: {
  vehicleType: string;
  riderFinalFare: number;
  policy: MarketplacePolicy;
  burnRate: number;
  zone: ZoneRealtimeSnapshot;
  platformFeeRate: number;
  isPeakHour?: boolean;
}): PricingV2Outcome {
  const { policy, burnRate, zone } = params;
  const liquidityActions: string[] = [];
  let surgeSensitivity = 1;
  let driverBoost = 0;
  let questIncentive = 0;
  const policyAgeWeeks = Math.max(
    0,
    Math.floor((Date.now() - (policy.createdAt?.getTime() ?? Date.now())) / (7 * 24 * 60 * 60 * 1000)),
  );
  let subsidyPct = policy.marketplaceMode === 'launch'
    ? policy.launchSubsidyPct
    : Math.max(0, policy.launchSubsidyPct - policyAgeWeeks * 0.05);

  if (zone.etaP90 > policy.etaTargetMin * 1.3) {
    surgeSensitivity *= 1.2;
    liquidityActions.push('surge_sensitivity_plus_20pct');
    driverBoost = boostForVehicle(params.vehicleType);
    liquidityActions.push('driver_boost_enabled');
  } else if (zone.supplyRate < policy.supplyThreshold && policy.marketplaceMode === 'launch') {
    driverBoost = boostForVehicle(params.vehicleType);
    liquidityActions.push('driver_boost_enabled');
  }

  if (zone.fulfillment < 0.85 && policy.marketplaceMode === 'launch') {
    subsidyPct = Math.max(subsidyPct, policy.launchSubsidyPct);
    questIncentive = 20;
    liquidityActions.push('subsidy_enabled_by_fulfillment');
    liquidityActions.push('quest_enabled_by_fulfillment');
  } else if (policy.marketplaceMode === 'launch' && zone.zoneHealth < 0.6) {
    questIncentive = 10;
    liquidityActions.push('quest_enabled_by_zone_health');
  }

  const supplyGap = zone.supplyRate < policy.supplyThreshold;
  const guaranteeEnabled = policy.marketplaceMode === 'scale' && !!params.isPeakHour && supplyGap;
  const guaranteeHourlyAmount = guaranteeEnabled ? boostForVehicle(params.vehicleType) * 2 : 0;
  if (guaranteeEnabled) {
    liquidityActions.push('smart_hourly_guarantee_enabled');
  }

  if (policy.marketplaceMode === 'scale' && zone.zoneHealth > 0.8) {
    driverBoost = 0;
    questIncentive = 0;
    liquidityActions.push('incentives_reduced_high_zone_health');
  }

  if (burnRate > policy.burnCap) {
    subsidyPct *= 0.9;
    questIncentive *= 0.9;
    liquidityActions.push('burn_guard_reduce_subsidy_10pct');
    liquidityActions.push('burn_guard_reduce_quest_10pct');
  }

  subsidyPct = clamp(subsidyPct, 0, 0.8);
  let subsidy = Math.min(params.riderFinalFare * subsidyPct, policy.launchSubsidyCap);
  let riderFare = params.riderFinalFare - subsidy;

  // Keep contribution guard: do not over-discount to extremely negative contribution.
  const driverTripFloor = Math.max(20, params.riderFinalFare * 0.55);
  const driverPayoutEstimate = Math.max(
    params.riderFinalFare * (1 - params.platformFeeRate),
    driverTripFloor,
  ) + driverBoost + (guaranteeEnabled ? guaranteeHourlyAmount / 4 : 0);
  let contribution = riderFare - driverPayoutEstimate - questIncentive;
  if (contribution < policy.contributionFloor) {
    const maxAllowedSubsidy =
      params.riderFinalFare - driverPayoutEstimate - questIncentive - policy.contributionFloor;
    subsidy = Math.min(subsidy, Math.max(0, maxAllowedSubsidy));
    riderFare = params.riderFinalFare - subsidy;
    contribution = riderFare - driverPayoutEstimate - questIncentive;
    liquidityActions.push('discount_blocked_by_contribution_guard');
  }

  return {
    riderFare: round2(Math.max(0, riderFare)),
    riderSubsidy: round2(Math.max(0, subsidy)),
    driverBoost: round2(Math.max(0, driverBoost)),
    questIncentive: round2(Math.max(0, questIncentive)),
    burnRate: round2(Math.max(0, burnRate)),
    contribution: round2(contribution),
    surgeSensitivity,
    liquidityActions,
    effectiveSubsidyPct: round2(subsidyPct),
    guarantee: {
      enabled: guaranteeEnabled,
      hourlyAmount: round2(guaranteeHourlyAmount),
    },
    driverTripFloor: round2(driverTripFloor),
    questPlan: {
      milestones: [
        { rides: 6, payout: 80 },
        { rides: 10, payout: 180 },
      ],
      perRidePeakBonus: params.isPeakHour ? 20 : 0,
    },
  };
}

export function computeZoneHealthScore(snapshot: {
  fulfillment: number;
  acceptRate: number;
  etaP90: number;
}): number {
  const etaComponent = snapshot.etaP90 > 0 ? 1 / snapshot.etaP90 : 0;
  return round2(0.5 * snapshot.fulfillment + 0.3 * snapshot.acceptRate + 0.2 * etaComponent);
}

export async function listZoneHealth(cityCode: string, limit: number = 50) {
  const db = prisma as any;
  return (await db.pricingZoneHealth?.findMany({
    where: { cityCode },
    orderBy: [{ healthScore: 'asc' }, { observedAt: 'desc' }],
    take: limit,
  })) ?? [];
}

export async function runMarketplaceGovernance(cityCode?: string) {
  const db = prisma as any;
  const policies = await db.pricingCityPolicy?.findMany({
    where: cityCode ? { cityCode } : { isActive: true },
  });
  if (!policies || policies.length === 0) return { updated: 0, details: [] as any[] };

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - 7);
  const weeklyLossThreshold = Number(process.env.MARKETPLACE_WEEKLY_LOSS_THRESHOLD ?? 50000);
  const details: any[] = [];
  let updated = 0;

  for (const policy of policies) {
    const burnRows = await db.pricingBurnMetric?.findMany({
      where: { cityCode: policy.cityCode, date: { gte: weekStart } },
      select: { subsidy: true, incentives: true, gmv: true },
    });
    const weeklyLoss = (burnRows ?? []).reduce((acc: number, r: any) => acc + (r.subsidy + r.incentives), 0);
    const weeklyGmv = (burnRows ?? []).reduce((acc: number, r: any) => acc + r.gmv, 0);

    const lowHealthZones = await db.pricingZoneHealth?.count({
      where: { cityCode: policy.cityCode, healthScore: { lt: 0.6 } },
    });

    let nextMode = policy.marketplaceMode;
    let nextSubsidyPct = policy.launchSubsidyPct;

    if (policy.marketplaceMode === 'launch' && weeklyLoss > weeklyLossThreshold && (lowHealthZones ?? 0) > 0) {
      nextMode = 'scale';
      updated++;
    }

    if (policy.marketplaceMode === 'scale' && policy.launchSubsidyPct > 0) {
      const weeks = Math.max(
        0,
        Math.floor((Date.now() - new Date(policy.createdAt).getTime()) / (7 * 24 * 60 * 60 * 1000)),
      );
      nextSubsidyPct = Math.max(0, policy.launchSubsidyPct - weeks * 0.05);
    }

    await db.pricingCityPolicy?.update({
      where: { cityCode: policy.cityCode },
      data: {
        marketplaceMode: nextMode,
        launchSubsidyPct: nextSubsidyPct,
      },
    });

    details.push({
      cityCode: policy.cityCode,
      weeklyLoss: round2(weeklyLoss),
      weeklyGmv: round2(weeklyGmv),
      lowHealthZones: lowHealthZones ?? 0,
      modeBefore: policy.marketplaceMode,
      modeAfter: nextMode,
      subsidyPctAfter: round2(nextSubsidyPct),
    });
  }

  return { updated, details };
}
