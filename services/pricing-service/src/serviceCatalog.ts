/**
 * App-facing service catalog — what riders see on home / booking screens.
 *
 * Availability is driven per city:
 *   - city_pricing.isActive   → whether a vehicle type is offered in that city
 *   - platform_config key "service_rollout_v1" → optional live/coming_soon/disabled overrides
 *   - cross-zone rules        → route-level blocks (marks a service disabled for a trip)
 *
 * This endpoint is intentionally additive and defensive: any lookup failure falls
 * back to the previous hardcoded behaviour so the app never loses its service grid.
 */

import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import {
  getBlockedVehicleTypesForCoordinates,
  getCityFromCoordinates,
  normalizeCity,
} from '@raahi/shared';

const logger = createLogger('service-catalog');

export type ServiceStatus = 'live' | 'coming_soon' | 'disabled';
export type ServiceFlow = 'ride' | 'rescue';

export interface ServiceCatalogItem {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  icon: string;
  imageKey: string;
  color: string;
  sortOrder: number;
  status: ServiceStatus;
  flow: ServiceFlow;
  category: string;
  capacity: number;
  badge?: string;
  showOnHome: boolean;
  showInBooking: boolean;
  blockedReason?: string;
}

export interface AvailableServicesActionCard {
  id: string;
  title: string;
  serviceType: string;
  imageKey: string;
  status: ServiceStatus;
}

export interface AvailableServicesResponse {
  city: string;
  services: ServiceCatalogItem[];
  actionCards: AvailableServicesActionCard[];
  version: number;
}

type ServiceCatalogBase = Omit<ServiceCatalogItem, 'status' | 'blockedReason'>;

/**
 * Canonical catalog — metadata only. Mirrors the previous hardcoded lists in
 * ServicesScreen._services and find_trip_screen fallbacks so the app renders
 * identically when no per-city overrides exist.
 */
const SERVICE_CATALOG: ServiceCatalogBase[] = [
  {
    id: 'cab_mini',
    name: 'Cab Mini',
    subtitle: 'Compact cars',
    description: 'Compact cars for city rides',
    icon: 'directions_car',
    imageKey: 'cab_mini',
    color: '#2196F3',
    sortOrder: 1,
    flow: 'ride',
    category: 'cab',
    capacity: 4,
    showOnHome: true,
    showInBooking: true,
  },
  {
    id: 'auto',
    name: 'Auto',
    subtitle: 'Budget-friendly',
    description: 'Budget-friendly auto rickshaw',
    icon: 'electric_rickshaw',
    imageKey: 'auto',
    color: '#4CAF50',
    sortOrder: 2,
    flow: 'ride',
    category: 'auto',
    capacity: 3,
    showOnHome: true,
    showInBooking: true,
  },
  {
    id: 'bike_taxi',
    name: 'Bike Taxi',
    subtitle: 'Quick two-wheeler rides',
    description: 'Fast, affordable two-wheeler taxi',
    icon: 'two_wheeler',
    imageKey: 'bike_taxi',
    color: '#D4956A',
    sortOrder: 3,
    flow: 'ride',
    category: 'bike',
    capacity: 1,
    showOnHome: true,
    showInBooking: true,
  },
  {
    id: 'bike_rescue',
    name: 'Rescue',
    subtitle: 'Quick pickup',
    description: 'Quick rescue on two-wheeler — pickup and drop anywhere',
    icon: 'two_wheeler',
    imageKey: 'bike_rescue',
    color: '#D4956A',
    sortOrder: 4,
    flow: 'rescue',
    category: 'bike',
    capacity: 1,
    badge: 'Rescue',
    showOnHome: true,
    showInBooking: true,
  },
  {
    id: 'cab_xl',
    name: 'Cab XL',
    subtitle: 'Spacious SUVs',
    description: 'Spacious SUVs for groups',
    icon: 'airport_shuttle',
    imageKey: 'cab_xl',
    color: '#7B1FA2',
    sortOrder: 5,
    flow: 'ride',
    category: 'cab',
    capacity: 6,
    badge: 'Family',
    showOnHome: true,
    showInBooking: true,
  },
  {
    id: 'cab_premium',
    name: 'Premium',
    subtitle: 'Luxury rides',
    description: 'Luxury sedans with top drivers',
    icon: 'diamond',
    imageKey: 'captain',
    color: '#FF9800',
    sortOrder: 6,
    flow: 'ride',
    category: 'cab',
    capacity: 4,
    badge: 'Premium',
    showOnHome: true,
    showInBooking: true,
  },
  {
    id: 'personal_driver',
    name: 'Driver Rental',
    subtitle: 'Hire a driver',
    description: 'Hire a driver for your own car',
    icon: 'person',
    imageKey: 'cab_premium',
    color: '#455A64',
    sortOrder: 7,
    flow: 'ride',
    category: 'personal_driver',
    capacity: 4,
    badge: 'Hourly',
    showOnHome: false,
    showInBooking: true,
  },
];

const ACTION_CARDS: Array<Omit<AvailableServicesActionCard, 'status'>> = [
  { id: 'get_rescued', title: 'Get Rescued', serviceType: 'bike_rescue', imageKey: 'rescued' },
  { id: 'hire_driver', title: 'Hire a Driver', serviceType: 'personal_driver', imageKey: 'hire' },
  { id: 'plan_trip', title: 'Plan a Trip', serviceType: 'cab_mini', imageKey: 'plan' },
];

/**
 * Default rollout when platform_config has no override. The current app marks
 * nothing as "coming soon", so the default keeps every service live. Ops can
 * override per-service / per-city via the service_rollout_v1 config.
 */
const DEFAULT_COMING_SOON = new Set<string>();

interface RolloutConfig {
  default?: Record<string, ServiceStatus>;
  cities?: Record<string, Record<string, ServiceStatus>>;
}

async function loadRolloutConfig(): Promise<RolloutConfig> {
  try {
    const row = await prisma.platformConfig.findUnique({
      where: { key: 'service_rollout_v1' },
    });
    if (row?.value) {
      return JSON.parse(row.value) as RolloutConfig;
    }
  } catch (error) {
    logger.warn(`[CATALOG] Failed to load/parse service_rollout_v1: ${error}`);
  }
  return {};
}

function resolveStatus(
  serviceId: string,
  city: string,
  isActiveInCity: boolean,
  rollout: RolloutConfig,
): ServiceStatus {
  if (!isActiveInCity) return 'disabled';

  const cityOverrides = rollout.cities?.[city] ?? rollout.cities?.[normalizeCity(city)];
  if (cityOverrides && cityOverrides[serviceId]) {
    return cityOverrides[serviceId];
  }

  if (rollout.default && rollout.default[serviceId]) {
    return rollout.default[serviceId];
  }

  return DEFAULT_COMING_SOON.has(serviceId) ? 'coming_soon' : 'live';
}

/**
 * Whether each catalog service is active in the given city. Reads city_pricing;
 * if the table has no rows for the city (or the query fails), every catalog
 * service is treated as active so the grid never disappears.
 */
async function getCityActiveMap(city: string): Promise<Map<string, boolean>> {
  const normalizedCity = normalizeCity(city);
  const map = new Map<string, boolean>();

  try {
    const rows = await prisma.cityPricing.findMany({
      where: { city: normalizedCity },
      select: { vehicleType: true, isActive: true },
    });

    if (rows.length > 0) {
      for (const row of rows) {
        map.set(row.vehicleType.toLowerCase(), row.isActive);
      }
      return map;
    }
  } catch (error) {
    logger.warn(`[CATALOG] city_pricing lookup failed for ${normalizedCity}, defaulting active: ${error}`);
  }

  for (const item of SERVICE_CATALOG) {
    map.set(item.id, true);
  }
  return map;
}

/**
 * Vehicle types that must not be offered/priced in a city right now
 * (status resolved to `disabled` or `coming_soon`). Used by calculate-all so
 * the booking picker honours the same rollout as the services hub.
 * Fails open (empty set) on any error so pricing never breaks.
 */
export async function getUnavailableVehicleTypesForCity(city: string): Promise<Set<string>> {
  const unavailable = new Set<string>();
  try {
    const normalized = normalizeCity(city);
    const [activeMap, rollout] = await Promise.all([
      getCityActiveMap(normalized),
      loadRolloutConfig(),
    ]);
    for (const base of SERVICE_CATALOG) {
      const isActiveInCity = activeMap.get(base.id) ?? true;
      const status = resolveStatus(base.id, normalized, isActiveInCity, rollout);
      if (status !== 'live') {
        unavailable.add(base.id);
      }
    }
  } catch (error) {
    logger.warn(`[CATALOG] getUnavailableVehicleTypesForCity failed for ${city}: ${error}`);
  }
  return unavailable;
}

export interface GetAvailableServicesParams {
  lat?: number;
  lng?: number;
  dropLat?: number;
  dropLng?: number;
  city?: string;
  includeDisabled?: boolean;
}

export async function getAvailableServices(
  params: GetAvailableServicesParams = {},
): Promise<AvailableServicesResponse> {
  let city = params.city ? normalizeCity(params.city) : 'delhi';

  if (params.lat != null && params.lng != null) {
    try {
      city = normalizeCity(await getCityFromCoordinates(params.lat, params.lng));
    } catch (error) {
      logger.warn(`[CATALOG] geocode failed, using ${city}: ${error}`);
    }
  }

  const [activeMap, rollout] = await Promise.all([
    getCityActiveMap(city),
    loadRolloutConfig(),
  ]);

  const blockedTypes = new Set<string>();
  const blockedReasons = new Map<string, string>();

  if (
    params.lat != null &&
    params.lng != null &&
    params.dropLat != null &&
    params.dropLng != null
  ) {
    try {
      const result = await getBlockedVehicleTypesForCoordinates(
        params.lat,
        params.lng,
        params.dropLat,
        params.dropLng,
      );
      for (const vt of result.blocked) {
        blockedTypes.add(vt.toLowerCase());
        blockedReasons.set(vt.toLowerCase(), 'Not available for this route');
      }
    } catch (error) {
      logger.warn(`[CATALOG] cross-zone check failed: ${error}`);
    }
  }

  const services: ServiceCatalogItem[] = [];

  for (const base of SERVICE_CATALOG) {
    const isActiveInCity = activeMap.get(base.id) ?? true;
    let status = resolveStatus(base.id, city, isActiveInCity, rollout);

    if (status === 'live' && blockedTypes.has(base.id.toLowerCase())) {
      status = 'disabled';
    }

    if (status === 'disabled' && !params.includeDisabled) {
      continue;
    }

    services.push({
      ...base,
      status,
      blockedReason: blockedReasons.get(base.id.toLowerCase()),
    });
  }

  services.sort((a, b) => a.sortOrder - b.sortOrder);

  const serviceById = new Map(services.map((s) => [s.id, s]));
  const actionCards: AvailableServicesActionCard[] = ACTION_CARDS.map((card) => ({
    ...card,
    status: serviceById.get(card.serviceType)?.status ?? 'disabled',
  })).filter((card) => card.status !== 'disabled' || params.includeDisabled);

  logger.info(
    `[CATALOG] city=${city} services=${services.length} live=${
      services.filter((s) => s.status === 'live').length
    }`,
  );

  return { city, services, actionCards, version: 1 };
}
