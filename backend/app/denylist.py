"""The curated brand denylist (§6 signal 1) and search pivot (§4)."""
import json
import re
from dataclasses import dataclass
from pathlib import Path

_PUNCT = re.compile(r"[^a-z0-9& ]+")
_SPACES = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    """Lowercase, strip punctuation and a leading 'the', collapse whitespace."""
    s = _PUNCT.sub(" ", name.lower().replace("'", ""))
    s = _SPACES.sub(" ", s).strip()
    if s.startswith("the "):
        s = s[4:]
    return s


@dataclass(frozen=True)
class Brand:
    brand: str
    aliases: tuple[str, ...]  # normalized
    domains: tuple[str, ...]
    kind: str  # "bigbox" | "ecommerce"
    category: str

    @property
    def names(self) -> tuple[str, ...]:
        return (normalize_name(self.brand), *self.aliases)


class Denylist:
    def __init__(self, brands: list[Brand]):
        self.brands = brands

    @classmethod
    def load(cls, path: Path | None = None) -> "Denylist":
        path = path or Path(__file__).parent / "denylist.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        brands = [
            Brand(
                brand=b["brand"],
                aliases=tuple(normalize_name(a) for a in b.get("aliases", [])),
                domains=tuple(b.get("domains", [])),
                kind=b["kind"],
                category=b["category"],
            )
            for b in raw["brands"]
        ]
        return cls(brands)

    def match_query(self, query: str) -> Brand | None:
        """A search query that *is* a denylisted brand (for the §4 pivot)."""
        q = normalize_name(query)
        for brand in self.brands:
            if q in brand.names:
                return brand
        return None

    def match_business(self, name: str, website: str | None) -> Brand | None:
        """A business result whose name or website domain matches the list."""
        n = normalize_name(name)
        host = _host_of(website)
        for brand in self.brands:
            for bn in brand.names:
                if n == bn or n.startswith(bn + " "):
                    return brand
            if host:
                for d in brand.domains:
                    if host == d or host.endswith("." + d):
                        return brand
        return None


def _host_of(website: str | None) -> str | None:
    if not website:
        return None
    m = re.match(r"https?://([^/]+)", website.lower())
    if not m:
        return None
    host = m.group(1).split(":")[0]
    return host.removeprefix("www.")
