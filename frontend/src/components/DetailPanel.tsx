import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { api, photoUrl } from "../api";
import { mapsUrl, scoreColor } from "../score";
import type { PlaceDetails } from "../types";
import ScoreBadge from "./ScoreBadge";
import Stars from "./Stars";

interface Props {
  placeId: string | null;
  onClose: () => void;
}

/** §7.5: address, hours, review snippets, photos, and the "why this score"
 * breakdown — where trust is earned. */
export default function DetailPanel({ placeId, onClose }: Props) {
  const [detail, setDetail] = useState<PlaceDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!placeId) return;
    let cancelled = false;
    api
      .place(placeId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [placeId]);

  return (
    <AnimatePresence>
      {placeId && (
        <>
          <motion.div
            className="detail-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="detail-panel"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 40 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            role="dialog"
            aria-modal="true"
            aria-label={detail?.name ?? "Place details"}
          >
            <button className="detail-close" onClick={onClose} aria-label="Close details">
              ✕
            </button>

            {error && <p className="detail-error">{error}</p>}
            {!detail && !error && <p className="detail-loading">Loading…</p>}

            {detail && (
              <div className="detail-body">
                <header className="detail-header">
                  <div>
                    <h2>{detail.name}</h2>
                    <Stars rating={detail.rating} count={detail.userRatingCount} />
                  </div>
                  <ScoreBadge score={detail.score} size={64} />
                </header>

                <section className="detail-why">
                  <h3>
                    Why this score{" "}
                    <span className="detail-tier" style={{ color: scoreColor(detail.score) }}>
                      {detail.tier}
                    </span>
                  </h3>
                  <ul>
                    {detail.breakdown.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </section>

                {detail.photoNames.length > 0 && (
                  <div className="detail-photos">
                    {detail.photoNames.map((name) => (
                      <img key={name} src={photoUrl(name, 320)} alt="" loading="lazy" />
                    ))}
                  </div>
                )}

                {detail.address && (
                  <section>
                    <h3>Address</h3>
                    <p>{detail.address}</p>
                  </section>
                )}

                {detail.openingHours.length > 0 && (
                  <section>
                    <h3>
                      Hours{" "}
                      {detail.openNow != null && (
                        <span className={detail.openNow ? "open-now" : "closed-now"}>
                          {detail.openNow ? "Open now" : "Closed now"}
                        </span>
                      )}
                    </h3>
                    <ul className="detail-hours">
                      {detail.openingHours.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  </section>
                )}

                {detail.reviews.length > 0 && (
                  <section>
                    <h3>What people say</h3>
                    {detail.reviews.map((r, i) => (
                      <blockquote className="detail-review" key={i}>
                        <p>“{r.text.length > 220 ? r.text.slice(0, 220) + "…" : r.text}”</p>
                        <footer>
                          {r.author} · {r.rating != null ? `★ ${r.rating}` : ""} {r.relativeTime}
                        </footer>
                      </blockquote>
                    ))}
                  </section>
                )}

                <div className="detail-actions">
                  {detail.websiteUri && (
                    <a
                      className="btn btn-ghost"
                      href={detail.websiteUri}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Website
                    </a>
                  )}
                  {detail.lat != null && detail.lng != null && (
                    <a
                      className="btn btn-primary"
                      href={mapsUrl(detail.name, detail.lat, detail.lng, detail.googleMapsUri)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in maps
                    </a>
                  )}
                </div>
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
