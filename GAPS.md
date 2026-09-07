# Remaining limitations

The public-release review closed the original high- and medium-severity findings: paid endpoints are bounded, every outbound Google call consumes a persistent quota, request bodies and identifiers are validated, cross-site API use is rejected, secrets remain server-side, regional cache keys no longer bleed across cities, generated state is ignored, and CI covers the production Worker plus the reference backend.

Known limitations:

- Anonymous cookies and keyed IP hashes are abuse controls, not durable identities. Distributed attackers can spread traffic, so Google Cloud quotas remain the independent final ceiling.
- Browser-side Maps JavaScript loads are governed by the referrer-restricted browser key and its Google Cloud quota rather than the Worker's server-call counter.
- Scores are heuristic. Localize labels a result provisional when its broader location count cannot be verified.
- Viewports crossing the antimeridian are rejected rather than interpreted incorrectly.
- The D1 usage table retains historical daily rows. At the configured public limits, growth is small; add scheduled cleanup if traffic becomes material.
- The frontend has production build coverage but no component-level automated suite yet.
- The Python/FastAPI implementation is maintained as a reference path. Production behavior is defined by `worker/`, and parity should be checked when scoring rules change.
