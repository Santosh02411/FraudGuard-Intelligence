/**
 * Shared location -> {lat, lon} lookup + haversine distance.
 * MUST stay in sync with ml_service/utils/geo.py — both sides need to
 * agree on distances for the ML feature payload to match training data.
 */

const LOCATION_COORDS = {
  'New York, US': [40.7128, -74.0060],
  'London, UK': [51.5074, -0.1278],
  'Toronto, CA': [43.6532, -79.3832],
  'Bengaluru, IN': [12.9716, 77.5946],
  'Sydney, AU': [-33.8688, 151.2093],
  'Berlin, DE': [52.5200, 13.4050],
  'Singapore, SG': [1.3521, 103.8198],
  'Lagos, NG': [6.5244, 3.3792],
  'Unknown': [0.0, 0.0],
  'Anonymous Proxy': [0.0, 0.0],
};
const DEFAULT_COORDS = [0.0, 0.0];

function coordsFor(location) {
  return LOCATION_COORDS[location] || DEFAULT_COORDS;
}

function haversineKm(locA, locB) {
  const [lat1, lon1] = coordsFor(locA);
  const [lat2, lon2] = coordsFor(locB);
  if (lat1 === lat2 && lon1 === lon2) return 0.0;
  const isDefault = (lat, lon) => lat === DEFAULT_COORDS[0] && lon === DEFAULT_COORDS[1];
  if (isDefault(lat1, lon1) || isDefault(lat2, lon2)) {
    return 15000.0; // Unknown/anonymized location -> treat as maximally distant
  }

  const R = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
}

module.exports = { coordsFor, haversineKm };
