import nodemailer, { Transporter } from 'nodemailer';
import { createLogger } from '@raahi/shared';

const logger = createLogger('auth-email');

export interface SmtpStatus {
  configured: boolean;
  ready: boolean;
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  secure: boolean;
  message: string;
}

function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at <= 1) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

function readSmtpConfig() {
  const host = (process.env.SMTP_HOST || '').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const from = (process.env.SMTP_FROM || user || '').trim();
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const placeholder =
    !host ||
    !user ||
    !pass ||
    user.includes('your-email') ||
    pass.includes('your-app-password');

  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    user,
    pass,
    from,
    secure,
    configured: !placeholder,
  };
}

let transporter: Transporter | null = null;
let lastVerifyAt = 0;
let lastVerifyOk = false;
let lastVerifyError: string | null = null;

function getTransporter(): Transporter | null {
  const cfg = readSmtpConfig();
  if (!cfg.configured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }
  return transporter;
}

/** Snapshot of SMTP configuration + last verify result (for ops / app messaging). */
export async function getSmtpStatus(verify = false): Promise<SmtpStatus> {
  const cfg = readSmtpConfig();
  if (!cfg.configured) {
    return {
      configured: false,
      ready: false,
      host: cfg.host || null,
      port: cfg.port,
      user: maskEmail(cfg.user),
      from: maskEmail(cfg.from),
      secure: cfg.secure,
      message:
        'SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optional SMTP_FROM).',
    };
  }

  if (verify || Date.now() - lastVerifyAt > 5 * 60 * 1000) {
    const transport = getTransporter();
    try {
      await transport!.verify();
      lastVerifyOk = true;
      lastVerifyError = null;
      lastVerifyAt = Date.now();
    } catch (error: any) {
      lastVerifyOk = false;
      lastVerifyError = error?.message || String(error);
      lastVerifyAt = Date.now();
      logger.warn('[SMTP] verify failed', { error: lastVerifyError });
    }
  }

  return {
    configured: true,
    ready: lastVerifyOk,
    host: cfg.host,
    port: cfg.port,
    user: maskEmail(cfg.user),
    from: maskEmail(cfg.from),
    secure: cfg.secure,
    message: lastVerifyOk
      ? 'SMTP is ready'
      : `SMTP configured but not ready: ${lastVerifyError || 'unknown error'}`,
  };
}

export function isSmtpConfigured(): boolean {
  return readSmtpConfig().configured;
}

export function allowDevEmailOtp(): boolean {
  return (
    process.env.ALLOW_DEV_OTP === 'true' ||
    process.env.NODE_ENV !== 'production'
  );
}

export async function sendVerificationEmail(params: {
  to: string;
  otp: string;
  firstName?: string;
}): Promise<{ sent: boolean; mode: 'smtp' | 'dev_log' }> {
  const { to, otp, firstName } = params;
  const name = firstName?.trim() || 'Driver';
  const subject = 'Raahi — verify your email';
  const text = `Hi ${name},\n\nYour Raahi email verification code is ${otp}.\nIt expires in 10 minutes.\n\nIf you did not request this, ignore this email.\n\n— Raahi`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 12px">Verify your email</h2>
      <p style="margin:0 0 16px">Hi ${name},</p>
      <p style="margin:0 0 16px">Use this code to verify your email for Raahi driver account:</p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:0 0 16px">${otp}</p>
      <p style="margin:0;color:#666;font-size:13px">Expires in 10 minutes. If you did not request this, ignore this email.</p>
    </div>
  `;

  const transport = getTransporter();
  if (!transport) {
    if (!allowDevEmailOtp()) {
      throw new Error('SMTP is not configured');
    }
    logger.info(`[EMAIL_DEV] OTP for ${to}: ${otp}`);
    return { sent: false, mode: 'dev_log' };
  }

  const cfg = readSmtpConfig();
  try {
    await transport.sendMail({
      from: cfg.from || cfg.user,
      to,
      subject,
      text,
      html,
    });
    lastVerifyOk = true;
    lastVerifyError = null;
    lastVerifyAt = Date.now();
    logger.info(`[EMAIL] Verification OTP sent to ${maskEmail(to)}`);
    return { sent: true, mode: 'smtp' };
  } catch (error: any) {
    lastVerifyOk = false;
    lastVerifyError = error?.message || String(error);
    lastVerifyAt = Date.now();
    logger.error('[EMAIL] Failed to send verification OTP', {
      to: maskEmail(to),
      error: lastVerifyError,
    });
    throw new Error(`Failed to send email: ${lastVerifyError}`);
  }
}
