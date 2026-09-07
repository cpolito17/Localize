import denylistData from "../backend/app/denylist.json";

const PUNCT = /[^\p{L}\p{N}& ]+/gu;
const SPACES = /\s+/g;

export function normalizeName(name: string): string {
  let normalized = name.toLocaleLowerCase("en-US").replace(/['’_]/g, " ");
  normalized = normalized.replace(PUNCT, " ").replace(SPACES, " ").trim();
  return normalized.startsWith("the ") ? normalized.slice(4) : normalized;
}

export interface Brand {
  brand: string;
  aliases: string[];
  domains: string[];
  kind: "bigbox" | "ecommerce";
  category: string;
}

function names(brand: Brand): string[] {
  return [normalizeName(brand.brand), ...brand.aliases];
}

function hostOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export class Denylist {
  readonly brands: Brand[];

  private constructor(brands: Brand[]) {
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
    return new Denylist(
      raw.brands.map((brand) => ({
        brand: brand.brand,
        aliases: (brand.aliases ?? []).map(normalizeName),
        domains: brand.domains ?? [],
        kind: brand.kind,
        category: brand.category,
      }))
    );
  }

  matchQuery(query: string): Brand | null {
    const normalized = normalizeName(query);
    return this.brands.find((brand) => names(brand).includes(normalized)) ?? null;
  }

  matchBusiness(name: string, website: string | null | undefined): Brand | null {
    const normalized = normalizeName(name);
    const host = hostOf(website);
    for (const brand of this.brands) {
      for (const brandName of names(brand)) {
        const prefixSafe = brandName.includes(" ") || brandName.length >= 7;
        if (normalized === brandName || (prefixSafe && normalized.startsWith(`${brandName} `))) {
          return brand;
        }
      }
      if (host && brand.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return brand;
      }
    }
    return null;
  }
}
