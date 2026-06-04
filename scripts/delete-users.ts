/**
 * Delete users by phone number.
 * Usage: npx ts-node scripts/delete-users.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PHONES_TO_DELETE = ['+918452925026', '+919211788026'];

async function main() {
  for (const phone of PHONES_TO_DELETE) {
    console.log(`\n🔍 Looking up user with phone: ${phone}`);

    const user = await prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        email: true,
        driverProfile: { select: { id: true } },
      },
    });

    if (!user) {
      console.log(`  ⚠️  No user found with phone ${phone}, skipping.`);
      continue;
    }

    console.log(`  Found: ${user.firstName} ${user.lastName || ''} (id=${user.id}, email=${user.email || 'none'})`);

    // 1. Nullify rides referencing this user as passenger (FK has no cascade)
    const ridesUpdated = await prisma.ride.updateMany({
      where: { passengerId: user.id },
      data: { passengerId: user.id }, // keep as-is for audit; or delete rides below
    });

    // Actually delete rides where this user is passenger
    const ridesDeleted = await prisma.ride.deleteMany({
      where: { passengerId: user.id },
    });
    console.log(`  🗑  Deleted ${ridesDeleted.count} rides as passenger`);

    // 2. Delete promo usages referencing this user
    const promoUsagesDeleted = await prisma.promoUsage.deleteMany({
      where: { userId: user.id },
    });
    console.log(`  🗑  Deleted ${promoUsagesDeleted.count} promo usages`);

    // 3. Delete the user (cascades: driver + docs/earnings/penalties/payouts/wallet, saved places, refresh tokens, notifications, support tickets set null)
    await prisma.user.delete({ where: { id: user.id } });
    console.log(`  ✅ User ${user.id} (${phone}) deleted successfully`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
