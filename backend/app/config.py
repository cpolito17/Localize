import os

SERVER_KEY = os.environ.get("GOOGLE_MAPS_SERVER_KEY", "")
BROWSER_KEY = os.environ.get("GOOGLE_MAPS_BROWSER_KEY", "")
MAP_ID = os.environ.get("GOOGLE_MAPS_MAP_ID", "DEMO_MAP_ID")
CACHE_DB_PATH = os.environ.get("CACHE_DB_PATH", "./localize-cache.db")

APP_NAME = "Localize"
TAGLINE = "Find it nearby. Keep it local."

# Display cap and grid for viewport thinning (§5).
RESULT_CAP = 36
GRID_SIZE = 6

# Wide-area box half-size in degrees for the location-count search (§6).
COUNT_AREA_HALF_LAT = 1.0
COUNT_AREA_HALF_LNG = 1.25

# Cached classifications expire after 30 days.
CACHE_TTL_SECONDS = 30 * 24 * 3600
