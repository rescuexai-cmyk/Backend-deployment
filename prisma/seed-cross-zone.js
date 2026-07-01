const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const rules = [
    // Delhi <-> Noida
    { origin: 'delhi', destination: 'noida', vehicleType: 'auto', isAllowed: false, reason: 'Auto-rickshaws do not have a permit to cross the Delhi-UP state border.' },
    { origin: 'delhi', destination: 'noida', vehicleType: 'bike_rescue', isAllowed: false, reason: 'Two-wheeler rescue services are restricted from crossing state border highways.' },
    { origin: 'noida', destination: 'delhi', vehicleType: 'auto', isAllowed: false, reason: 'Auto-rickshaws do not have a permit to cross the UP-Delhi state border.' },
    { origin: 'noida', destination: 'delhi', vehicleType: 'bike_rescue', isAllowed: false, reason: 'Two-wheeler rescue services are restricted from crossing state border highways.' },

    // Delhi <-> Gurgaon
    { origin: 'delhi', destination: 'gurgaon', vehicleType: 'auto', isAllowed: false, reason: 'Auto-rickshaws do not have a permit to cross the Delhi-Haryana state border.' },
    { origin: 'delhi', destination: 'gurgaon', vehicleType: 'bike_rescue', isAllowed: false, reason: 'Two-wheeler rescue services are restricted from crossing state border highways.' },
    { origin: 'gurgaon', destination: 'delhi', vehicleType: 'auto', isAllowed: false, reason: 'Auto-rickshaws do not have a permit to cross the Haryana-Delhi state border.' },
    { origin: 'gurgaon', destination: 'delhi', vehicleType: 'bike_rescue', isAllowed: false, reason: 'Two-wheeler rescue services are restricted from crossing state border highways.' }
  ];

  console.log('Seeding cross-zone rules...');
  for (const rule of rules) {
    await prisma.crossZoneRule.upsert({
      where: {
        origin_destination_vehicleType: {
          origin: rule.origin,
          destination: rule.destination,
          vehicleType: rule.vehicleType
        }
      },
      update: {
        isAllowed: rule.isAllowed,
        reason: rule.reason
      },
      create: {
        origin: rule.origin,
        destination: rule.destination,
        vehicleType: rule.vehicleType,
        isAllowed: rule.isAllowed,
        reason: rule.reason
      }
    });
  }
  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
