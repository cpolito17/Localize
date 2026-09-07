from app.denylist import Denylist, normalize_name


def test_normalize_name():
    assert normalize_name("The Home Depot") == "home depot"
    assert normalize_name("Joe's  Hardware!") == "joes hardware"
    assert normalize_name("LOWE'S Home Improvement") == "lowes home improvement"
    assert normalize_name("Café Zola") == "café zola"
    assert normalize_name("서울 상점") == "서울 상점"


def test_query_match_pivots_to_category():
    dl = Denylist.load()
    brand = dl.match_query("Home Depot")
    assert brand is not None
    assert brand.category == "hardware store"
    assert dl.match_query("the home depot").brand == "Home Depot"
    assert dl.match_query("best buy").category == "electronics store"


def test_query_no_match_passes_through():
    dl = Denylist.load()
    assert dl.match_query("AA batteries") is None
    assert dl.match_query("oil change") is None
    assert dl.match_query("furniture") is None


def test_business_match_by_name_prefix():
    dl = Denylist.load()
    assert dl.match_business("Walmart Supercenter", None).brand == "Walmart"
    assert dl.match_business("Target", None).brand == "Target"
    assert dl.match_business("The Home Depot", None).brand == "Home Depot"
    # Not a prefix-word match: "Targeted Fitness" must not match "Target".
    assert dl.match_business("Targeted Fitness", None) is None
    assert dl.match_business("Target Archery Range", None) is None
    assert dl.match_business("Gap Fillers Drywall", None) is None
    assert dl.match_business("Napa Valley Wine Tours", None) is None
    assert dl.match_business("NAPA Auto Parts", None).brand == "NAPA Auto Parts"


def test_business_match_by_domain():
    dl = Denylist.load()
    b = dl.match_business("Some Storefront", "https://www.bestbuy.com/store/123")
    assert b is not None and b.brand == "Best Buy"
    assert dl.match_business("Indie Shop", "https://indieshop.example.com") is None


def test_ecommerce_vs_bigbox_kind():
    dl = Denylist.load()
    assert dl.match_query("Amazon").kind == "ecommerce"
    assert dl.match_query("Costco").kind == "bigbox"
