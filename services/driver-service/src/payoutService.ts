import Razorpay from 'razorpay';
import { PrismaClient, PayoutStatus, PayoutAccountType, WalletTransactionType } from '@prisma/client';

const prisma = new PrismaClient();

// Initialize Razorpay (use environment variables)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
});
// Razorpay SDK typings vary across versions; keep runtime calls stable via narrow any-cast bridge.
const razorpayClient = razorpay as any;

// ═══════════════════════════════════════════════════════════════════════════════
// PAYOUT ACCOUNT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

interface CreatePayoutAccountInput {
  driverId: string;
  accountType: PayoutAccountType;
  // Bank details
  bankName?: string;
  accountNumber?: string;
  ifscCode?: string;
  accountHolderName?: string;
  // UPI details
  upiId?: string;
}

/**
 * Create or update a payout account for a driver
 */
export async function createPayoutAccount(input: CreatePayoutAccountInput) {
  const { driverId, accountType, bankName, accountNumber, ifscCode, accountHolderName, upiId } = input;

  // Validate based on account type
  if (accountType === 'BANK_ACCOUNT') {
    if (!bankName || !accountNumber || !ifscCode || !accountHolderName) {
      throw new Error('Bank account requires bankName, accountNumber, ifscCode, and accountHolderName');
    }
  } else if (accountType === 'UPI') {
    if (!upiId) {
      throw new Error('UPI account requires upiId');
    }
    // Basic UPI ID validation
    if (!upiId.includes('@')) {
      throw new Error('Invalid UPI ID format');
    }
  }

  // Get driver info for Razorpay contact
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    include: { user: true },
  });

  if (!driver) {
    throw new Error('Driver not found');
  }

  // Check if driver already has a primary account of this type
  const existingAccount = await prisma.driverPayoutAccount.findFirst({
    where: { driverId, accountType },
  });

  // Create Razorpay Contact if not exists
  let razorpayContactId = existingAccount?.razorpayContactId;
  
  if (!razorpayContactId && process.env.RAZORPAY_KEY_ID) {
    try {
      const contact: any = await razorpayClient.contacts.create({
        name: `${driver.user.firstName} ${driver.user.lastName || ''}`.trim(),
        email: driver.user.email || undefined,
        contact: driver.user.phone,
        type: 'vendor',
        reference_id: driverId,
      });
      razorpayContactId = contact.id;
    } catch (error) {
      console.error('Failed to create Razorpay contact:', error);
      // Continue without Razorpay - will be created during payout
    }
  }

  // Create Razorpay Fund Account
  let razorpayFundAccountId: string | undefined;
  
  if (razorpayContactId && process.env.RAZORPAY_KEY_ID) {
    try {
      if (accountType === 'BANK_ACCOUNT') {
        const fundAccount: any = await razorpayClient.fundAccount.create({
          contact_id: razorpayContactId,
          account_type: 'bank_account',
          bank_account: {
            name: accountHolderName!,
            ifsc: ifscCode!,
            account_number: accountNumber!,
          },
        });
        razorpayFundAccountId = fundAccount.id;
      } else if (accountType === 'UPI') {
        const fundAccount: any = await razorpayClient.fundAccount.create({
          contact_id: razorpayContactId,
          account_type: 'vpa',
          vpa: {
            address: upiId!,
          },
        });
        razorpayFundAccountId = fundAccount.id;
      }
    } catch (error) {
      console.error('Failed to create Razorpay fund account:', error);
      // Continue - fund account can be created during payout
    }
  }

  // Mask account number for storage (keep last 4 digits)
  const maskedAccountNumber = accountNumber ? `****${accountNumber.slice(-4)}` : undefined;

  // If this is the first account, make it primary
  const accountCount = await prisma.driverPayoutAccount.count({ where: { driverId } });
  const isPrimary = accountCount === 0;

  // Create the payout account
  const payoutAccount = await prisma.driverPayoutAccount.create({
    data: {
      driverId,
      accountType,
      bankName,
      accountNumber: maskedAccountNumber,
      accountNumberEncrypted: accountNumber, // In production, encrypt this
      ifscCode,
      accountHolderName,
      upiId,
      razorpayContactId,
      razorpayFundAccountId,
      isPrimary,
      isVerified: false, // Will be verified via penny drop or UPI validation
    },
  });

  // Ensure driver has a wallet
  await ensureDriverWallet(driverId);

  return payoutAccount;
}

/**
 * Get all payout accounts for a driver
 */
export async function getPayoutAccounts(driverId: string) {
  return prisma.driverPayoutAccount.findMany({
    where: { driverId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      accountType: true,
      bankName: true,
      accountNumber: true, // Already masked
      ifscCode: true,
      accountHolderName: true,
      upiId: true,
      isVerified: true,
      isPrimary: true,
      createdAt: true,
    },
  });
}

/**
 * Set a payout account as primary
 */
export async function setPrimaryAccount(driverId: string, accountId: string) {
  // Verify account belongs to driver
  const account = await prisma.driverPayoutAccount.findFirst({
    where: { id: accountId, driverId },
  });

  if (!account) {
    throw new Error('Account not found');
  }

  // Remove primary from all other accounts
  await prisma.driverPayoutAccount.updateMany({
    where: { driverId, isPrimary: true },
    data: { isPrimary: false },
  });

  // Set this account as primary
  return prisma.driverPayoutAccount.update({
    where: { id: accountId },
    data: { isPrimary: true },
  });
}

/**
 * Delete a payout account
 */
export async function deletePayoutAccount(driverId: string, accountId: string) {
  const account = await prisma.driverPayoutAccount.findFirst({
    where: { id: accountId, driverId },
  });

  if (!account) {
    throw new Error('Account not found');
  }

  // Check if there are pending payouts to this account
  const pendingPayouts = await prisma.driverPayout.count({
    where: {
      payoutAccountId: accountId,
      status: { in: ['PENDING', 'PROCESSING'] },
    },
  });

  if (pendingPayouts > 0) {
    throw new Error('Cannot delete account with pending payouts');
  }

  await prisma.driverPayoutAccount.delete({ where: { id: accountId } });

  // If this was primary, set another account as primary
  if (account.isPrimary) {
    const nextAccount = await prisma.driverPayoutAccount.findFirst({
      where: { driverId },
      orderBy: { createdAt: 'asc' },
    });
    if (nextAccount) {
      await prisma.driverPayoutAccount.update({
        where: { id: nextAccount.id },
        data: { isPrimary: true },
      });
    }
  }

  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ensure driver has a wallet, create if not exists
 */
export async function ensureDriverWallet(driverId: string) {
  let wallet = await prisma.driverWallet.findUnique({ where: { driverId } });
  
  if (!wallet) {
    // Calculate initial balance from existing earnings
    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { totalEarnings: true },
    });

    wallet = await prisma.driverWallet.create({
      data: {
        driverId,
        availableBalance: driver?.totalEarnings || 0,
        totalEarned: driver?.totalEarnings || 0,
      },
    });
  }

  return wallet;
}

/**
 * Get driver wallet with balance details
 */
export async function getDriverWallet(driverId: string) {
  const wallet = await ensureDriverWallet(driverId);
  
  // Get pending payouts
  const pendingPayouts = await prisma.driverPayout.aggregate({
    where: { driverId, status: { in: ['PENDING', 'PROCESSING'] } },
    _sum: { amount: true },
  });

  // Get unpaid penalties
  const unpaidPenalties = await prisma.driverPenalty.aggregate({
    where: { driverId, status: 'PENDING' },
    _sum: { amount: true },
  });

  return {
    ...wallet,
    pendingWithdrawals: pendingPayouts._sum.amount || 0,
    unpaidPenalties: unpaidPenalties._sum.amount || 0,
    effectiveBalance: wallet.availableBalance - (unpaidPenalties._sum.amount || 0),
  };
}

/**
 * Credit earnings to driver wallet (called when ride completes)
 */
export async function creditEarnings(driverId: string, amount: number, rideId: string) {
  const wallet = await ensureDriverWallet(driverId);

  const updatedWallet = await prisma.driverWallet.update({
    where: { driverId },
    data: {
      availableBalance: { increment: amount },
      totalEarned: { increment: amount },
    },
  });

  // Log transaction
  await prisma.walletTransaction.create({
    data: {
      driverId,
      type: WalletTransactionType.RIDE_EARNING,
      amount,
      balanceBefore: wallet.availableBalance,
      balanceAfter: updatedWallet.availableBalance,
      referenceType: 'ride',
      referenceId: rideId,
      description: `Earnings from ride ${rideId.slice(-6)}`,
    },
  });

  return updatedWallet;
}

/**
 * Debit penalty from driver wallet
 */
export async function debitPenalty(driverId: string, amount: number, penaltyId: string, reason: string) {
  const wallet = await ensureDriverWallet(driverId);

  const updatedWallet = await prisma.driverWallet.update({
    where: { driverId },
    data: {
      availableBalance: { decrement: amount },
    },
  });

  // Log transaction
  await prisma.walletTransaction.create({
    data: {
      driverId,
      type: WalletTransactionType.PENALTY,
      amount: -amount,
      balanceBefore: wallet.availableBalance,
      balanceAfter: updatedWallet.availableBalance,
      referenceType: 'penalty',
      referenceId: penaltyId,
      description: `Penalty: ${reason}`,
    },
  });

  return updatedWallet;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WITHDRAWAL / PAYOUT
// ═══════════════════════════════════════════════════════════════════════════════

interface WithdrawRequest {
  driverId: string;
  amount: number;
  payoutAccountId?: string; // If not provided, use primary account
}

/**
 * Request a withdrawal/payout
 */
export async function requestWithdrawal(input: WithdrawRequest) {
  const { driverId, amount, payoutAccountId } = input;

  // Get wallet
  const walletInfo = await getDriverWallet(driverId);
  
  // Validate amount
  if (amount <= 0) {
    throw new Error('Amount must be greater than 0');
  }

  if (amount < walletInfo.minimumWithdrawal) {
    throw new Error(`Minimum withdrawal amount is ₹${walletInfo.minimumWithdrawal}`);
  }

  if (amount > walletInfo.effectiveBalance) {
    throw new Error(`Insufficient balance. Available: ₹${walletInfo.effectiveBalance.toFixed(2)}`);
  }

  // Get payout account
  let account;
  if (payoutAccountId) {
    account = await prisma.driverPayoutAccount.findFirst({
      where: { id: payoutAccountId, driverId },
    });
  } else {
    account = await prisma.driverPayoutAccount.findFirst({
      where: { driverId, isPrimary: true },
    });
  }

  if (!account) {
    throw new Error('No payout account found. Please add a bank account or UPI ID.');
  }

  // Calculate fee (configurable - currently 0)
  const feeRate = parseFloat(process.env.PAYOUT_FEE_RATE || '0');
  const flatFee = parseFloat(process.env.PAYOUT_FLAT_FEE || '0');
  const fee = Math.max(amount * feeRate, flatFee);
  const netAmount = amount - fee;

  // Create payout request
  const payout = await prisma.$transaction(async (tx) => {
    // Deduct from wallet
    const wallet = await tx.driverWallet.update({
      where: { driverId },
      data: {
        availableBalance: { decrement: amount },
      },
    });

    // Create payout record
    const newPayout = await tx.driverPayout.create({
      data: {
        driverId,
        payoutAccountId: account!.id,
        amount,
        fee,
        netAmount,
        status: 'PENDING',
        payoutMethod: account!.accountType,
      },
    });

    // Log transaction
    await tx.walletTransaction.create({
      data: {
        driverId,
        type: WalletTransactionType.WITHDRAWAL,
        amount: -amount,
        balanceBefore: wallet.availableBalance + amount,
        balanceAfter: wallet.availableBalance,
        referenceType: 'payout',
        referenceId: newPayout.id,
        description: `Withdrawal to ${account!.accountType === 'UPI' ? account!.upiId : account!.bankName}`,
      },
    });

    return newPayout;
  });

  // Process payout asynchronously (or immediately for UPI)
  processPayoutAsync(payout.id).catch(console.error);

  return payout;
}

/**
 * Process payout via Razorpay
 */
async function processPayoutAsync(payoutId: string) {
  const payout = await prisma.driverPayout.findUnique({
    where: { id: payoutId },
    include: { payoutAccount: true },
  });

  if (!payout || payout.status !== 'PENDING') {
    return;
  }

  // Update status to processing
  await prisma.driverPayout.update({
    where: { id: payoutId },
    data: { status: 'PROCESSING', processedAt: new Date() },
  });

  // If Razorpay is not configured, mark as completed (for testing)
  if (!process.env.RAZORPAY_KEY_ID || !payout.payoutAccount?.razorpayFundAccountId) {
    console.log(`[PAYOUT] Razorpay not configured, simulating payout completion for ${payoutId}`);
    await completePayout(payoutId, `SIM_${Date.now()}`);
    return;
  }

  try {
    // Create Razorpay payout
    const razorpayPayout: any = await razorpayClient.payouts.create({
      account_number: process.env.RAZORPAY_ACCOUNT_NUMBER!,
      fund_account_id: payout.payoutAccount.razorpayFundAccountId,
      amount: Math.round(payout.netAmount * 100), // Convert to paise
      currency: 'INR',
      mode: payout.payoutMethod === 'UPI' ? 'UPI' : 'IMPS',
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: payoutId,
    });

    // Update with Razorpay payout ID
    await prisma.driverPayout.update({
      where: { id: payoutId },
      data: { razorpayPayoutId: razorpayPayout.id },
    });

    // Razorpay will send webhook for completion
    console.log(`[PAYOUT] Razorpay payout created: ${razorpayPayout.id}`);
  } catch (error: any) {
    console.error(`[PAYOUT] Razorpay payout failed:`, error);
    await failPayout(payoutId, error.message || 'Payment processing failed');
  }
}

/**
 * Mark payout as completed (called by webhook or after simulation)
 */
export async function completePayout(payoutId: string, transactionId: string) {
  const payout = await prisma.driverPayout.findUnique({ where: { id: payoutId } });
  
  if (!payout || payout.status === 'COMPLETED') {
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Update payout status
    await tx.driverPayout.update({
      where: { id: payoutId },
      data: {
        status: 'COMPLETED',
        transactionId,
        completedAt: new Date(),
      },
    });

    // Update wallet
    await tx.driverWallet.update({
      where: { driverId: payout.driverId },
      data: {
        totalWithdrawn: { increment: payout.netAmount },
        lastPayoutAt: new Date(),
      },
    });
  });

  console.log(`[PAYOUT] Completed: ${payoutId}, UTR: ${transactionId}`);
}

/**
 * Mark payout as failed and refund to wallet
 */
export async function failPayout(payoutId: string, reason: string) {
  const payout = await prisma.driverPayout.findUnique({ where: { id: payoutId } });
  
  if (!payout || payout.status === 'COMPLETED') {
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Update payout status
    await tx.driverPayout.update({
      where: { id: payoutId },
      data: {
        status: 'FAILED',
        failureReason: reason,
      },
    });

    // Refund to wallet
    const wallet = await tx.driverWallet.update({
      where: { driverId: payout.driverId },
      data: {
        availableBalance: { increment: payout.amount },
      },
    });

    // Log refund transaction
    await tx.walletTransaction.create({
      data: {
        driverId: payout.driverId,
        type: WalletTransactionType.REFUND,
        amount: payout.amount,
        balanceBefore: wallet.availableBalance - payout.amount,
        balanceAfter: wallet.availableBalance,
        referenceType: 'payout',
        referenceId: payoutId,
        description: `Withdrawal failed: ${reason}`,
      },
    });
  });

  console.log(`[PAYOUT] Failed: ${payoutId}, Reason: ${reason}`);
}

/**
 * Get payout history for a driver
 */
export async function getPayoutHistory(driverId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;

  const [payouts, total] = await Promise.all([
    prisma.driverPayout.findMany({
      where: { driverId },
      orderBy: { requestedAt: 'desc' },
      skip,
      take: limit,
      include: {
        payoutAccount: {
          select: {
            accountType: true,
            bankName: true,
            accountNumber: true,
            upiId: true,
          },
        },
      },
    }),
    prisma.driverPayout.count({ where: { driverId } }),
  ]);

  return {
    payouts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get wallet transaction history
 */
export async function getWalletTransactions(driverId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.walletTransaction.count({ where: { driverId } }),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-SETTLEMENT (for cron job)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process auto-settlement for all eligible drivers
 * Should be called by a cron job (e.g., daily at midnight or weekly on Monday)
 */
export async function processAutoSettlement(minAmount = 100) {
  console.log(`[SETTLEMENT] Starting auto-settlement, minimum: ₹${minAmount}`);

  // Get all drivers with balance above minimum
  const eligibleWallets = await prisma.driverWallet.findMany({
    where: {
      availableBalance: { gte: minAmount },
    },
    include: {
      driver: {
        include: {
          payoutAccounts: {
            where: { isPrimary: true },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`[SETTLEMENT] Found ${eligibleWallets.length} eligible drivers`);

  const results = {
    processed: 0,
    failed: 0,
    skipped: 0,
    totalAmount: 0,
  };

  for (const wallet of eligibleWallets) {
    const primaryAccount = wallet.driver.payoutAccounts[0];
    
    if (!primaryAccount) {
      console.log(`[SETTLEMENT] Skipping driver ${wallet.driverId}: No payout account`);
      results.skipped++;
      continue;
    }

    try {
      const payout = await requestWithdrawal({
        driverId: wallet.driverId,
        amount: wallet.availableBalance,
        payoutAccountId: primaryAccount.id,
      });

      // Mark as auto-settlement
      await prisma.driverPayout.update({
        where: { id: payout.id },
        data: { isAutoSettlement: true },
      });

      results.processed++;
      results.totalAmount += wallet.availableBalance;
      console.log(`[SETTLEMENT] Processed driver ${wallet.driverId}: ₹${wallet.availableBalance}`);
    } catch (error: any) {
      console.error(`[SETTLEMENT] Failed for driver ${wallet.driverId}:`, error.message);
      results.failed++;
    }
  }

  console.log(`[SETTLEMENT] Complete:`, results);
  return results;
}
