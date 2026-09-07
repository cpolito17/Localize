import httpx
from fastapi.testclient import TestClient

from app import config
from app.main import app


def client(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "CACHE_DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setattr(config, "SERVER_KEY", "test-key")
    monkeypatch.setattr(config, "RATE_LIMIT_SECRET", "test-secret-that-is-at-least-32-characters")
    return TestClient(app, base_url="https://testserver")


def test_rejects_photo_path_traversal(monkeypatch, tmp_path):
    with client(monkeypatch, tmp_path) as api:
        response = api.get(
            "/api/photo", params={"name": "places/a/photos/../../v1/places", "w": 640}
        )
    assert response.status_code == 400


def test_rejects_invalid_and_antimeridian_bounds(monkeypatch, tmp_path):
    with client(monkeypatch, tmp_path) as api:
        response = api.post(
            "/api/search",
            json={
                "query": "coffee",
                "bounds": {"north": 20, "south": 30, "east": -170, "west": 170},
                "userLocation": None,
            },
        )
    assert response.status_code == 422


def test_network_failures_map_to_502(monkeypatch, tmp_path):
    with client(monkeypatch, tmp_path) as api:
        async def fail(*_args, **_kwargs):
            raise httpx.ConnectError("offline")

        app.state.places.search_text = fail
        response = api.post(
            "/api/search",
            json={
                "query": "coffee",
                "bounds": {"north": 43, "south": 42, "east": -82, "west": -84},
                "userLocation": None,
            },
        )
    assert response.status_code == 502
    assert response.json() == {"detail": "Couldn't reach Google Places. Please try again."}


def test_rejects_cross_site_api_requests(monkeypatch, tmp_path):
    with client(monkeypatch, tmp_path) as api:
        response = api.get("/api/geocode?q=coffee", headers={"Sec-Fetch-Site": "cross-site"})
    assert response.status_code == 403
