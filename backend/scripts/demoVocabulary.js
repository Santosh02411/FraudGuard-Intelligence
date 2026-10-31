/**
 * Vocabulary for the demo data generator — kept aligned with:
 *   - frontend/src/pages/NewTransactionPage.js (CATEGORIES/LOCATIONS)
 *   - ml_service/generate_dataset.py (MERCHANT_CATEGORIES)
 *   - backend/models/geo.js (LOCATION_COORDS)
 * so seeded transactions use exactly the vocabulary the trained model
 * and rule engine actually recognize.
 */

const MERCHANTS_BY_CATEGORY = {
  grocery: ['Whole Foods', 'Trader Joe\'s', 'Kroger', 'Safeway'],
  food: ['Starbucks', "McDonald's", 'Chipotle', 'DoorDash'],
  electronics: ['Apple Store', 'Best Buy', 'Amazon', 'Newegg'],
  travel: ['Airbnb', 'United Airlines', 'Marriott', 'Uber'],
  entertainment: ['Netflix', 'Spotify', 'AMC Theatres', 'Steam'],
  utilities: ['ConEd', 'Verizon', 'Comcast', 'National Grid'],
  clothing: ['Zara', 'Nike', 'Nordstrom', "Levi's"],
  health: ['CVS Pharmacy', 'Walgreens', 'One Medical', 'GNC'],
  crypto: ['CryptoExchange Pro', 'CoinDesk Trading', 'BitVault'],
  gambling: ['Casino Vegas', 'BetStream Live', 'PokerRoyale'],
  wire_transfer: ['QuickCoin Anonymous', 'FastCash Wire Instant', 'GlobalWire Transfer'],
};

const SAFE_CATEGORIES = Object.keys(MERCHANTS_BY_CATEGORY).filter(
  (c) => !['crypto', 'gambling', 'wire_transfer'].includes(c)
);
const HIGH_RISK_CATEGORIES = ['crypto', 'gambling', 'wire_transfer'];

const SAFE_LOCATIONS = ['New York, US', 'London, UK', 'Toronto, CA', 'Bengaluru, IN', 'Sydney, AU', 'Berlin, DE', 'Singapore, SG'];
const HIGH_RISK_LOCATIONS = ['Unknown', 'Anonymous Proxy', 'Lagos, NG'];

const FIRST_NAMES = ['James', 'Maria', 'Wei', 'Fatima', 'Liam', 'Sofia', 'Kenji', 'Amara', 'Noah', 'Priya', 'Lucas', 'Elena'];
const LAST_NAMES = ['Smith', 'Garcia', 'Chen', 'Ali', 'Murphy', 'Rossi', 'Tanaka', 'Okafor', 'Brown', 'Sharma', 'Silva', 'Novak'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

module.exports = {
  MERCHANTS_BY_CATEGORY,
  SAFE_CATEGORIES,
  HIGH_RISK_CATEGORIES,
  SAFE_LOCATIONS,
  HIGH_RISK_LOCATIONS,
  FIRST_NAMES,
  LAST_NAMES,
  pick,
  randRange,
};
