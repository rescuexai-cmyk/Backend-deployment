// In-memory OTP store for development / when Redis is not used
const otpStore = new Map<string, { otp: string; expiresAt: number }>();

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function setOtp(phone: string, otp: string): Promise<void> {
  otpStore.set(phone, { otp, expiresAt: Date.now() + TTL_MS });
}

export async function getOtp(phone: string): Promise<string | null> {
  const entry = otpStore.get(phone);
  if (!entry || entry.expiresAt < Date.now()) {
    otpStore.delete(phone);
    return null;
  }
  return entry.otp;
}

export async function deleteOtp(phone: string): Promise<void> {
  otpStore.delete(phone);
}
