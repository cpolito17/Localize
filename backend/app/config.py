import os

SERVER_KEY = os.environ.get("GOOGLE_MAPS_SERVER_KEY", "")
BROWSER_KEY = os.environ.get("GOOGLE_MAPS_BROWSER_KEY", "")
MAP_ID = os.environ.get("GOOGLE_MAPS_MAP_ID", "DEMO_MAP_ID")
CACHE_DB_PATH = os.environ.get("CACHE_DB_PATH", "./localize-cache.db")
RATE_LIMIT_SECRET = os.environ.get("RATE_LIMIT_SECRET", "")

APP_NAME = "Localize"
TAGLINE = "Find it nearby. Keep it local."

# Display cap and grid for viewport thinning (§5).
RESULT_CAP = 12
GRID_SIZE = 4

# Public-demo budgets. They are intentionally conservative because a single
# cache-cold search can fan out into several paid Places requests.
RATE_LIMIT_SEARCHES_PER_DAY = int(os.environ.get("RATE_LIMIT_SEARCHES_PER_DAY", "8"))
RATE_LIMIT_SEARCHES_PER_MINUTE = int(os.environ.get("RATE_LIMIT_SEARCHES_PER_MINUTE", "3"))
RATE_LIMIT_IP_MULTIPLIER = int(os.environ.get("RATE_LIMIT_IP_MULTIPLIER", "4"))
RATE_LIMIT_GLOBAL_SEARCHES_PER_DAY = int(
    os.environ.get("RATE_LIMIT_GLOBAL_SEARCHES_PER_DAY", "40")
)
GOOGLE_API_DAILY_LIMIT = int(os.environ.get("GOOGLE_API_DAILY_LIMIT", "300"))

SEARCH_MAX_RESULTS = 20
BRAND_SEARCH_MAX_RESULTS = 10
COUNT_SEARCH_MAX_RESULTS = 20

# Wide-area box half-size in degrees for the location-count search (§6).
COUNT_AREA_HALF_LAT = 1.0
COUNT_AREA_HALF_LNG = 1.25

# Cached classifications expire after 30 days.
CACHE_TTL_SECONDS = 30 * 24 * 3600
