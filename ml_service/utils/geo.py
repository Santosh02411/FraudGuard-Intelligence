"""
Shared location -> (lat, lon) lookup + haversine distance helper.

Kept as a small static table (not a real geocoding API — no network
access in this environment) so that "geo_distance_from_last_km" is a
genuine numeric distance rather than a binary same/different flag.
A mirrored table lives in backend/models/geo.js so the Node backend can
compute the same feature at serving time using the same coordinates.
"""

import math

LOCATION_COORDS = {
    "New York, US": (40.7128, -74.0060),
    "London, UK": (51.5074, -0.1278),
    "Toronto, CA": (43.6532, -79.3832),
    "Bengaluru, IN": (12.9716, 77.5946),
    "Sydney, AU": (-33.8688, 151.2093),
    "Berlin, DE": (52.5200, 13.4050),
    "Singapore, SG": (1.3521, 103.8198),
    "Lagos, NG": (6.5244, 3.3792),
    "Unknown": (0.0, 0.0),
    "Anonymous Proxy": (0.0, 0.0),
}

DEFAULT_COORDS = (0.0, 0.0)


def coords_for(location: str):
    return LOCATION_COORDS.get(location, DEFAULT_COORDS)


def haversine_km(loc_a: str, loc_b: str) -> float:
    """Great-circle distance in km between two named locations."""
    lat1, lon1 = coords_for(loc_a)
    lat2, lon2 = coords_for(loc_b)
    if (lat1, lon1) == (lat2, lon2):
        return 0.0
    if (lat1, lon1) == DEFAULT_COORDS or (lat2, lon2) == DEFAULT_COORDS:
        # Unknown/anonymized location -> treat as maximally distant (risk signal)
        return 15000.0

    R = 6371.0  # Earth radius, km
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return round(2 * R * math.asin(math.sqrt(a)), 2)
