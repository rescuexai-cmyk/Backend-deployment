/**
 * Seed operational zones (H3 geofences) used for cross-zone permit enforcement.
 *
 * Zones are treated as data, the way Uber/Ola manage service areas:
 *   1. If prisma/zones/<code>.geojson exists, its polygon(s) are used (PREFERRED —
 *      drop in official administrative boundaries from OSM / data.gov.in / GADM
 *      for exact border accuracy).
 *   2. Otherwise a built-in approximate polygon is used so the system is
 *      "ready on day one". Approximations are good enough to demo cross-zone
 *      behavior but SHOULD be replaced with official GeoJSON for production
 *      border enforcement.
 *
 * A location resolves to exactly one zone (h3Index is globally unique). Where
 * two seeded polygons overlap near a border, the LAST zone seeded wins; the
 * order below is chosen so UP/Haryana claim border cells (leans toward
 * enforcing permits rather than silently allowing a crossing).
 *
 * Usage:  node prisma/seed-zones.js
 * Env:    ZONE_H3_RESOLUTION (default 8 — must match the backend's setting)
 */

const fs = require('fs');
const path = require('path');
const h3 = require('h3-js');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Must match ZONE_H3_RESOLUTION in packages/shared/src/zoneService.ts
const ZONE_H3_RESOLUTION = Number(process.env.ZONE_H3_RESOLUTION || 8);

// Keep in sync with CITY_ALIASES in packages/shared/src/cityUtils.ts
const CITY_ALIASES = {
  'new delhi': 'delhi',
  'delhi ncr': 'delhi',
  gurugram: 'gurgaon',
  'greater noida': 'noida',
  'gautam buddha nagar': 'noida',
  'gautam buddh nagar': 'noida',
  'gb nagar': 'noida',
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  mysore: 'mysuru',
  trivandrum: 'thiruvananthapuram',
  vizag: 'visakhapatnam',
  vishakhapatnam: 'visakhapatnam',
  baroda: 'vadodara',
  cochin: 'kochi',
  pondicherry: 'puducherry',
  gauhati: 'guwahati',
  benares: 'varanasi',
  banaras: 'varanasi',
};

function normalizeCity(code) {
  const lower = String(code).toLowerCase().trim();
  return CITY_ALIASES[lower] || lower;
}

/**
 * Built-in approximate boundaries (GeoJSON [lng, lat] outer rings).
 * Seed order matters at overlaps — Delhi first, UP/Haryana after.
 */
const ZONE_DEFS = [
  {
    code: 'delhi',
    name: 'Delhi (NCT)',
    type: 'state',
    polygon: [[
      [76.86, 28.55], [76.90, 28.78], [77.05, 28.88], [77.28, 28.85],
      [77.34, 28.66], [77.33, 28.53], [77.31, 28.44], [77.16, 28.40],
      [77.02, 28.44], [76.93, 28.50], [76.86, 28.55],
    ]],
  },
  {
    code: 'gurgaon',
    name: 'Gurgaon (Gurugram, Haryana)',
    type: 'city',
    polygon: [[
      [76.82, 28.30], [76.84, 28.54], [77.14, 28.54], [77.15, 28.34],
      [77.02, 28.22], [76.88, 28.24], [76.82, 28.30],
    ]],
  },
  {
    code: 'noida',
    name: 'Noida & Greater Noida (UP)',
    type: 'city',
    polygon: [[
      [77.29, 28.40], [77.31, 28.64], [77.58, 28.63], [77.63, 28.38],
      [77.52, 28.26], [77.31, 28.30], [77.29, 28.40],
    ]],
  },
];

/** Extract an array of polygon ring-sets ([[outer],[hole]...]) from a GeoJSON object. */
function ringsFromGeoJson(geo) {
  const polys = [];
  const pushGeometry = (g) => {
    if (!g) return;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => polys.push(p));
  };
  if (geo.type === 'FeatureCollection') geo.features.forEach((f) => pushGeometry(f.geometry));
  else if (geo.type === 'Feature') pushGeometry(geo.geometry);
  else pushGeometry(geo);
  return polys;
}

function cellsFromPolygons(polygons) {
  const cells = new Set();
  for (const rings of polygons) {
    for (const cell of h3.polygonToCells(rings, ZONE_H3_RESOLUTION, true)) {
      cells.add(cell);
    }
  }
  return Array.from(cells);
}

function loadZoneCells(def) {
  const geojsonPath = path.join(__dirname, 'zones', `${def.code}.geojson`);
  if (fs.existsSync(geojsonPath)) {
    const geo = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
    const cells = cellsFromPolygons(ringsFromGeoJson(geo));
    return { cells, source: 'official GeoJSON' };
  }
  if (!def.polygon) return { cells: [], source: 'no geometry' };
  const cells = cellsFromPolygons([def.polygon]);
  return { cells, source: 'built-in approximation' };
}

/**
 * Build the full list of zones to seed:
 *   - every prisma/zones/*.geojson file (auto-discovered), plus
 *   - any built-in ZONE_DEFS that don't have a matching GeoJSON file (fallback
 *     approximations, so nothing is lost if a file is missing).
 * GeoJSON files always win over inline approximations for the same code.
 */
function collectZones() {
  const dir = path.join(__dirname, 'zones');
  const byCode = new Map();

  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.geojson')) continue;
      const code = normalizeCity(file.replace(/\.geojson$/, ''));
      let props = {};
      try {
        const geo = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        props = (geo.type === 'Feature' && geo.properties) || {};
      } catch { /* validated later during load */ }
      byCode.set(code, {
        code,
        name: props.name || code.replace(/\b\w/g, (c) => c.toUpperCase()),
        type: props.type || 'city',
      });
    }
  }

  for (const def of ZONE_DEFS) {
    const code = normalizeCity(def.code);
    if (!byCode.has(code)) byCode.set(code, def);
  }

  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

async function main() {
  console.log(`Seeding zones at H3 resolution ${ZONE_H3_RESOLUTION}...`);

  const zones = collectZones();
  let seeded = 0;

  for (const def of zones) {
    const code = normalizeCity(def.code);
    const { cells, source } = loadZoneCells(def);

    if (cells.length === 0) {
      console.warn(`  ! ${code}: no cells generated, skipping`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const zone = await tx.zone.upsert({
        where: { code },
        update: { name: def.name, type: def.type || 'city', isActive: true },
        create: { code, name: def.name, type: def.type || 'city' },
      });
      // Replace the cell set atomically; detach any cells currently owned elsewhere.
      await tx.zoneCell.deleteMany({ where: { zoneId: zone.id } });
      await tx.zoneCell.deleteMany({ where: { h3Index: { in: cells } } });
      await tx.zoneCell.createMany({
        data: cells.map((h3Index) => ({ zoneId: zone.id, h3Index })),
        skipDuplicates: true,
      });
    });

    seeded++;
    console.log(`  ✓ ${code}: ${cells.length} cells (${source})`);
  }

  console.log(`Zone seeding completed — ${seeded} zone(s) seeded.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
