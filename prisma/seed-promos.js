const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Launch promo codes. Idempotent (upsert by code) — safe to re-run.
// After launch these are managed live via POST /api/promo/admin (no deploy needed).
const PROMOS = [
  {
    code: 'FIRST50',
    type: 'PERCENT',
    value: 50,
    maxDiscount: 100,
    minFare: 99,
    perUserLimit: 1,
    isFirstRideOnly: true,
    isActive: true,
  },
  {
    code: 'RAAHI20',
    type: 'PERCENT',
    value: 20,
    maxDiscount: 50,
    minFare: 149,
    perUserLimit: 5,
    isFirstRideOnly: false,
    isActive: true,
  },
  {
    code: 'FLAT30',
    type: 'FLAT',
    value: 30,
    minFare: 199,
    perUserLimit: 3,
    isFirstRideOnly: false,
    isActive: true,
  },
];

async function main() {
  console.log('Seeding promo codes...');
  for (const p of PROMOS) {
    const data = {
      type: p.type,
      value: p.value,
      maxDiscount: p.maxDiscount ?? null,
      minFare: p.minFare ?? null,
      usageLimit: p.usageLimit ?? null,
      perUserLimit: p.perUserLimit ?? 1,
      validFrom: new Date(),
      validTo: p.validTo ?? null,
      vehicleTypes: p.vehicleTypes ?? [],
      cities: p.cities ?? [],
      isFirstRideOnly: p.isFirstRideOnly ?? false,
      isActive: p.isActive ?? true,
    };
    await prisma.promo.upsert({
      where: { code: p.code },
      update: data,
      create: { code: p.code, ...data },
    });
    console.log(`  ✓ ${p.code}`);
  }
  console.log('Promo seeding completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
