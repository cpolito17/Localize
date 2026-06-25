interface Props {
  rating: number | null;
  count: number;
}

export default function Stars({ rating, count }: Props) {
  if (rating == null) {
    return <span className="stars stars-empty">No ratings yet</span>;
  }
  const pct = (rating / 5) * 100;
  return (
    <span className="stars" aria-label={`Rated ${rating} out of 5 from ${count} reviews`}>
      <span className="stars-value">{rating.toFixed(1)}</span>
      <span className="stars-track" aria-hidden="true">
        <span className="stars-glyphs">★★★★★</span>
        <span className="stars-fill" style={{ width: `${pct}%` }}>
          ★★★★★
        </span>
      </span>
      <span className="stars-count">({count.toLocaleString()})</span>
    </span>
  );
}
