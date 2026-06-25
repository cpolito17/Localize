import { useEffect, useRef } from "react";
import type { SearchResult } from "../types";
import ResultCard from "./ResultCard";

export type SortMode = "score" | "distance";

interface Props {
  results: SearchResult[];
  sort: SortMode;
  onSortChange: (s: SortMode) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  loading: boolean;
  sparse: boolean;
  onZoomOut: () => void;
  pivot: { brand: string; category: string } | null;
}

export default function ResultsList({
  results,
  sort,
  onSortChange,
  selectedId,
  onSelect,
  onOpenDetail,
  loading,
  sparse,
  onZoomOut,
  pivot,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Pin -> card sync (§7.2): scroll the selected card into view.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-place-id="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedId]);

  const sorted = [...results].sort((a, b) =>
    sort === "score"
      ? b.score - a.score || (b.rating ?? 0) - (a.rating ?? 0)
      : a.distanceMeters - b.distanceMeters
  );

  return (
    <div className="results">
      <div className="results-header">
        <span className="results-count">
          {loading ? "Searching…" : `${results.length} place${results.length === 1 ? "" : "s"}`}
        </span>
        <div className="sort-toggle" role="radiogroup" aria-label="Sort results">
          <button
            role="radio"
            aria-checked={sort === "score"}
            className={sort === "score" ? "active" : ""}
            onClick={() => onSortChange("score")}
          >
            Most local
          </button>
          <button
            role="radio"
            aria-checked={sort === "distance"}
            className={sort === "distance" ? "active" : ""}
            onClick={() => onSortChange("distance")}
          >
            Nearest
          </button>
        </div>
      </div>

      {pivot && !loading && (
        <p className="pivot-note">
          Showing local <strong>{pivot.category}</strong> alternatives to {pivot.brand} — the chain
          is in the list too, for comparison.
        </p>
      )}

      <div className="results-scroll" ref={listRef}>
        {loading ? (
          <SkeletonCards />
        ) : (
          <>
            {sorted.map((r, i) => (
              <ResultCard
                key={r.placeId}
                result={r}
                index={i}
                selected={r.placeId === selectedId}
                onSelect={() => onSelect(r.placeId)}
                onOpenDetail={() => onOpenDetail(r.placeId)}
              />
            ))}
            {sparse && (
              <div className="sparse-note">
                <p>
                  {results.length === 0
                    ? "No places found in this view."
                    : "Slim pickings right here — this is everything in view."}
                </p>
                <button className="btn btn-primary" onClick={onZoomOut}>
                  Zoom out &amp; search a wider area
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SkeletonCards() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div className="card card-skeleton" key={i}>
          <div className="card-photo shimmer" />
          <div className="card-body">
            <div className="skeleton-line shimmer" style={{ width: "70%" }} />
            <div className="skeleton-line shimmer" style={{ width: "45%" }} />
            <div className="skeleton-line shimmer" style={{ width: "55%" }} />
          </div>
        </div>
      ))}
    </>
  );
}
