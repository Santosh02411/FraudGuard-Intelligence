/**
 * Email sending — password reset and email verification links.
 * ==================================================================
 * No SMTP provider is required to run this app locally: with SMTP_HOST
 * unset (the default in development/test — see config/env.js), every
 * email is logged instead of sent, so a developer can copy the
 * verification/reset link straight out of the server console. Set
 * SMTP_HOST/SMTP_USER/SMTP_PASS (config/env.js) to send real email
 * through any standard SMTP provider (SendGrid, Postmark, SES, etc) —
 * staging/production refuse to start without SMTP_HOST configured,
 * specifically so this never silently ships as "log-only" in a real
 * deployment.
 *
 * This is a deliberate simplification worth being upfront about, in
 * the same spirit as the device-fingerprinting caveat in
 * ml_service/README.md: a real product would likely use a transactional
 * email API (SendGrid/Postmark's HTTP API, not raw SMTP) for better
 * deliverability tracking, but nodemailer's SMTP transport covers the
 * same functional need with zero vendor lock-in for a project this size.
 */

const nodemailer = require('nodemailer');
const config = require('../config/env');
const logger = require('../config/logger');

let transporter = null;
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

/**
 * Sends an email, or logs it if no SMTP transport is configured.
 * Never throws — a failed/unavailable email send shouldn't fail the
 * request that triggered it (e.g. registration still succeeds even if
 * the verification email can't go out); the caller can still tell
 * success from failure via the returned boolean if it needs to.
 */
async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    logger.info('Email not sent — no SMTP configured, logging instead', { to, subject, text });
    return true;
  }
  try {
    await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
    return true;
  } catch (err) {
    logger.error('Failed to send email', { to, subject, error: err.message });
    return false;
  }
}

async function sendVerificationEmail(user, token) {
  const link = `${config.frontendUrl}/verify-email?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Verify your FraudGuard email address',
    text: `Hi ${user.username},\n\nVerify your email address by visiting:\n${link}\n\nThis link expires in ${config.emailVerificationExpiresHours} hours. If you didn't create a FraudGuard account, you can ignore this email.`,
    html: `<p>Hi ${user.username},</p><p>Verify your email address by clicking the link below:</p><p><a href="${link}">${link}</a></p><p>This link expires in ${config.emailVerificationExpiresHours} hours. If you didn't create a FraudGuard account, you can ignore this email.</p>`,
  });
}

async function sendPasswordResetEmail(user, token) {
  const link = `${config.frontendUrl}/reset-password?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Reset your FraudGuard password',
    text: `Hi ${user.username},\n\nReset your password by visiting:\n${link}\n\nThis link expires in ${config.passwordResetExpiresMinutes} minutes. If you didn't request this, you can ignore this email — your password won't be changed.`,
    html: `<p>Hi ${user.username},</p><p>Reset your password by clicking the link below:</p><p><a href="${link}">${link}</a></p><p>This link expires in ${config.passwordResetExpiresMinutes} minutes. If you didn't request this, you can ignore this email — your password won't be changed.</p>`,
  });
}

module.exports = { sendMail, sendVerificationEmail, sendPasswordResetEmail };
