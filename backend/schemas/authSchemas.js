const { z } = require('zod');
const { isDemoEmail } = require('../config/demo');

// Real people can't register (or change to) an address on the reserved demo
// domain, so a demo account can never be mistaken for — or deleted as — a
// real customer (see config/demo.js).
const realEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address')
  .refine((e) => !isDemoEmail(e), 'This email domain is reserved');

// Password strength (feature: password strength rules). Each rule is a
// separate check so a failing password reports every rule it misses at
// once (see middleware/validate.js -> errorHandler.js's `details` array),
// not just the first one — more useful feedback than one generic
// "password too weak" message.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200)
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number')
  .regex(/[^A-Za-z0-9]/, 'Password must include a special character (e.g. !@#$%)');

const register = z.object({
  username: z.string().trim().min(3, 'Username must be at least 3 characters').max(30),
  email: realEmail,
  password,
});

const login = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

const refresh = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

// --- Password reset (feature: forgot-password / reset-password flow) ---

const forgotPassword = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
});

const resetPassword = z.object({
  token: z.string().min(1, 'token is required'),
  password,
});

// --- Email verification (feature: email verification on register) ---

const verifyEmail = z.object({
  token: z.string().min(1, 'token is required'),
});

// --- Self-service profile management ---

const changePassword = z.object({
  currentPassword: z.string().min(1, 'currentPassword is required'),
  newPassword: password,
});

const changeEmail = z.object({
  newEmail: realEmail,
  currentPassword: z.string().min(1, 'currentPassword is required'),
});

// --- MFA / TOTP 2FA ---

const mfaEnable = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be a 6-digit authenticator code'),
});

const mfaDisable = z.object({
  password: z.string().min(1, 'password is required'),
});

// code is intentionally loosely validated here (min length only) —
// it may be a 6-digit TOTP code or a backup code ("a1b2-c3d4e5"), and
// routes/auth.js tries both rather than the schema picking one shape.
const mfaLogin = z.object({
  mfaToken: z.string().min(1, 'mfaToken is required'),
  code: z.string().min(6, 'code is required'),
});

// --- Account deletion (feature: self-service data export + deletion) ---

const deleteAccount = z.object({
  password: z.string().min(1, 'password is required'),
});

module.exports = {
  register, login, refresh, password,
  forgotPassword, resetPassword, verifyEmail,
  changePassword, changeEmail,
  mfaEnable, mfaDisable, mfaLogin,
  deleteAccount,
};
