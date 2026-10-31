/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // IBM Plex: an enterprise/technical typeface pairing (Sans for
        // UI text, Mono for data — transaction IDs, fraud scores,
        // device fingerprints, API keys) that fits a fraud-operations
        // tool's "instrument panel" character, rather than a generic
        // system-font or Inter default. Falls back gracefully if the
        // web font hasn't loaded yet.
        sans: ['"IBM Plex Sans"', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Re-themes every existing `purple-*` utility class across the
      // app in one place — a "signal" cyan in place of the generic
      // violet/purple that's become the default AI-SaaS accent color,
      // and one that doesn't collide with the low/medium/high risk
      // color coding (green/amber/red) already used throughout.
      colors: {
        purple: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
        },
      },
    },
  },
  plugins: [],
};
