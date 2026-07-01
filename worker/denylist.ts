// The curated brand denylist (§6 signal 1) and search pivot (§4).
// Faithful port of backend/app/denylist.py.
import denylistData from "./denylist.json";

const PUNCT = /[^a-z0-9& ]+/g;
const SPACES = /\s+/g;

/** Lowercase, strip punctuation and a leading 'the', collapse whitespace. */
export function normalizeName(name: string): string {
  let s = name.toLowerCase().replace(/'/g, "").replace(PUNCT, " ");
  s = s.replace(SPACES, " ").trim();
  if (s.startsWith("the ")) s = s.slice(4);
  return s;
}

export interface Brand {
  brand: string;
  aliases: string[]; // normalized
  domains: string[];
  kind: "bigbox" | "ecommerce";
  category: string;
}

/** brand + normalized aliases, matched against normalized business names. */
function names(b: Brand): string[] {
  return [normalizeName(b.brand), ...b.aliases];
}

function hostOf(website: string | null | undefined): string | null {
  if (!website) return null;
  const m = /^https?:\/\/([^/]+)/.exec(website.toLowerCase());
  if (!m) return null;
  const host = m[1].split(":")[0];
  return host.startsWith("www.") ? host.slice(4) : host;
}

export class Denylist {
  readonly brands: Brand[];

  constructor(brands: Brand[]) {
    this.brands = brands;
  }

  static load(): Denylist {
    const raw = denylistData as {
      brands: Array<{
        brand: string;
        aliases?: string[];
        domains?: string[];
        kind: "bigbox" | "ecommerce";
        category: string;
      }>;
    };
    const brands: Brand[] = raw.brands.map((b) => ({
      brand: b.brand,
      aliases: (b.aliases ?? []).map(normalizeName),
      domains: b.domains ?? [],
      kind: b.kind,
      category: b.category,
    }));
    return new Denylist(brands);
  }

  /** A search query that *is* a denylisted brand (for the §4 pivot). */
  matchQuery(query: string): Brand | null {
    const q = normalizeName(query);
    for (const brand of this.brands) {
      if (names(brand).includes(q)) return brand;
    }
    return null;
  }

  /** A business result whose name or website domain matches the list. */
  matchBusiness(name: string, website: string | null | undefined): Brand | null {
    const n = normalizeName(name);
    const host = hostOf(website);
    for (const brand of this.brands) {
      for (const bn of names(brand)) {
        if (n === bn || n.startsWith(bn + " ")) return brand;
      }
      if (host) {
        for (const d of brand.domains) {
          if (host === d || host.endsWith("." + d)) return brand;
        }
      }
    }
    return null;
  }
}
