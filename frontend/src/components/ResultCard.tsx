import { motion, useReducedMotion } from "framer-motion";
import { photoUrl } from "../api";
import { formatDistance, mapsUrl } from "../score";
import type { SearchResult } from "../types";
import ScoreBadge from "./ScoreBadge";
import Stars from "./Stars";

interface Props {
  result: SearchResult;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onOpenDetail: () => void;
}

export default function ResultCard({ result, index, selected, onSelect, onOpenDetail }: Props) {
  const reduced = useReducedMotion();
  return (
    <motion.article
      layout
      className={`card${selected ? " card-selected" : ""}`}
      data-place-id={result.placeId}
      initial={reduced ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.05, 0.5), ease: "easeOut" }}
      onClick={() => {
        onSelect();
        onOpenDetail();
      }}
    >
      <div className="card-photo">
        {result.photoName ? (
          <img src={photoUrl(result.photoName)} alt={result.name} loading="lazy" />
        ) : (
          <div className="card-photo-placeholder" aria-hidden="true">
            <PlaceholderIcon />
          </div>
        )}
        <div className="card-badge">
          <ScoreBadge score={result.score} size={48} />
        </div>
      </div>
      <div className="card-body">
        <h3 className="card-name">{result.name}</h3>
        <Stars rating={result.rating} count={result.userRatingCount} />
        <p className="card-tier">
          {result.tier} · {formatDistance(result.distanceMeters)}
        </p>
        <div className="card-actions">
          {result.websiteUri && (
            <a
              className="btn btn-ghost"
              href={result.websiteUri}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              Website
            </a>
          )}
          <a
            className="btn btn-primary"
            href={mapsUrl(result.name, result.lat, result.lng, result.googleMapsUri)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            Open in maps
          </a>
        </div>
      </div>
    </motion.article>
  );
}

function PlaceholderIcon() {
  return (
    <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="#C9C2B4" strokeWidth="2.5">
      <path d="M8 20 L24 8 L40 20" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 20 V38 H36 V20" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 38 V28 H28 V38" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
