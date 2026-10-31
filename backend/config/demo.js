/**
 * Demo-data identity + safety rules, shared by the seeder, the user
 * repository and registration so they can never disagree.
 *
 * Every seeded account lives on a RESERVED email domain. That makes demo
 * accounts (a) recognisable in the admin UI, (b) removable by
 * `seedDemoData --reset` without touching real customers, and (c) impossible
 * for a real person to register by accident or on purpose — registration
 * rejects the domain (see schemas/authSchemas.js).
 */
const DEMO_EMAIL_DOMAIN = 'demo.fraudguard.io';
const DEFAULT_DEMO_PASSWORD = 'demo1234'; // only ever used in development/test

const isDemoEmail = (email) =>
  typeof email === 'string' && email.toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);

module.exports = { DEMO_EMAIL_DOMAIN, DEFAULT_DEMO_PASSWORD, isDemoEmail };
