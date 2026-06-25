import { FormEvent, useState } from "react";

interface Props {
  compact: boolean;
  initialValue?: string;
  onSearch: (query: string) => void;
}

/** §7.1: one field for brands, categories, or products. Hero treatment on
 * load; collapses to a pill once a search is active (compact). */
export default function SearchBar({ compact, initialValue = "", onSearch }: Props) {
  const [value, setValue] = useState(initialValue);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (q) onSearch(q);
  }

  return (
    <form className={`searchbar${compact ? " searchbar-compact" : ""}`} onSubmit={submit}>
      <svg className="searchbar-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder='Try "hardware store", "AA batteries", or "Home Depot"'
        aria-label="Search for a product, category, or store"
        enterKeyHint="search"
      />
      <button type="submit" className="btn btn-primary searchbar-go">
        Search
      </button>
    </form>
  );
}
