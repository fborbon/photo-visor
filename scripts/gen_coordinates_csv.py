#!/usr/bin/env python3
"""
Generate/refresh coordinates.csv at the repository root.

Sources:
  - scripts/state.db          — active photos and their filesystem paths
  - frontend/src/utils/sysTags.ts — SYS_TAG_COORDS for lat/lng values

Run standalone:  python3 scripts/gen_coordinates_csv.py
Auto-run:        called at the end of every `bulk-ingest.py --reindex-only` / full ingest.
"""

import csv, re, sqlite3
from collections import defaultdict
from pathlib import Path, PurePosixPath

HERE        = Path(__file__).parent
REPO_ROOT   = HERE.parent
DB_PATH     = HERE / "state.db"
SYSTAGS_TS  = REPO_ROOT / "frontend" / "src" / "utils" / "sysTags.ts"
OUTPUT_CSV  = REPO_ROOT / "coordinates.csv"
PHOTOS_ROOT = Path("/media/patito/seagate/Personal/Fotos")


# ── Parse SYS_TAG_COORDS from sysTags.ts ─────────────────────────────────────

def parse_coords(ts_path: Path) -> dict[str, tuple[float, float]]:
    """Extract every  'Key:Value': [lat, lng]  entry from the TS file."""
    coords: dict[str, tuple[float, float]] = {}
    pat = re.compile(r"'([^']+)'\s*:\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]")
    for m in pat.finditer(ts_path.read_text(encoding="utf-8")):
        coords[m.group(1)] = (float(m.group(2)), float(m.group(3)))
    return coords


# ── Python mirrors of the TypeScript helper functions ────────────────────────
# Keep in sync with frontend/src/utils/sysTags.ts: leadingCity, sysTagCityKey,
# sysTagCountryKey.

CITY_ALIASES_PY: dict[str, str] = {
    'logrono':               'Logroño',
    'londres':               'London',
    'rio urederra':          'Urederra',
    'alaiz aerial view':     'Alaiz',
    'alaiz desde carretera': 'Alaiz',
    'alaiz visita newa':     'Alaiz',
    'nacionalidad':          'Madrid',
    'polideportivo cartago': 'Cinco pinos de Cartago',
    'brussells':             'Bruselas',
    'vitoria-gasteiz':       'Vitoria',
    'milan':                 'Milano',
    'bruges':                'Brugge',
}

def _leading_city(segment: str) -> str:
    d = segment.find(' - ')
    s = segment.find('/')
    ends = [i for i in [d, s] if i > 0]
    raw      = segment[:min(ends)] if ends else segment
    stripped = re.sub(r'\s+\d+$', '', raw).strip()
    return CITY_ALIASES_PY.get(stripped.lower(), stripped)

def _country_key(tag_name: str) -> str:
    slash = tag_name.find('/')
    first = tag_name[:slash] if slash > 0 else tag_name
    dash  = first.find(' - ')
    return (first[:dash] if dash > 0 else first).strip()

def _city_key(tag_name: str) -> str:
    slash = tag_name.find('/')
    if slash < 0:
        d = tag_name.find(' - ')
        return tag_name[d + 3:] if d > 0 else ''
    return _leading_city(tag_name[slash + 1:])

def _lookup_coords(
    country: str, city: str,
    coords: dict[str, tuple[float, float]],
) -> tuple[float, float] | None:
    # 1. Exact match
    if (v := coords.get(f'{country}:{city}')): return v
    # 2. Strip trip-description suffix from city (split on ' - ')
    d = city.find(' - ')
    if d > 0:
        if (v := coords.get(f'{country}:{city[:d].strip()}')): return v
    # 3. Country-capital fallback
    return coords.get(f'{country}:')


# ── _system_tag — inline copy from bulk-ingest.py ────────────────────────────
# Keep in sync with scripts/bulk-ingest.py: _system_tag, _NON_PLACE_SUBFOLDERS,
# CITY_FOLDER_NORMALIZE.

_GEO_CONTINENT_ROOTS = {"Europa", "Norteamerica", "Latinoamerica", "Asia", "Africa", "Oceania"}

_NON_PLACE_SUBFOLDERS = {
    'calibration', 'city', 'instruments', 'met_mast', 'selfies', 'targets',
    'wsv1', 'wsv2', 'nokia camera', 'pastelaria pingo doce',
}

_COUNTRY_NORMALIZE_BI = {
    "España": "Spain", "Francia": "France", "Alemania": "Germany",
    "Italia": "Italy", "Belgica": "Belgium", "Holanda": "Netherlands",
    "Dinamarca": "Denmark", "Noruega": "Norway", "Inglaterra": "England",
    "Irlanda": "Ireland", "Grecia": "Greece", "Hungria": "Hungary",
    "Polonia": "Poland", "Israel": "Israel", "Monaco": "Monaco",
    "Andorra": "Andorra", "Suiza": "Switzerland", "Turquia": "Turkey",
    "Portugal": "Portugal", "Yugoslavia": "Croatia",
    "Austria": "Austria", "Eslovaquia": "Slovakia",
    "Republica Checa": "Czech Republic", "Paises Balticos": None,
    "Egipto": "Egypt", "Colombia": "Colombia", "Cuba": "Cuba",
    "Guatemala": "Guatemala", "Chile": "Chile", "Argentina": "Argentina",
    "Uruguay": "Uruguay", "Peru": "Peru", "Perú": "Peru",
    "Bolivia": "Bolivia", "Costa Rica": "Costa Rica",
    "Canada": "Canada", "USA": "USA",
    "Japón": "Japan", "Tailandia": "Thailand",
    "Australia": "Australia", "UAE": "UAE",
}

_AMIGOS_COUNTRY_MAP_BI: dict[str, tuple[str, str]] = {
    "España":       ("España",       "Spain"),
    "Portugal":     ("Portugal",     "Portugal"),
    "Alemania":     ("Alemania",     "Germany"),
    "Francia":      ("Francia",      "France"),
    "Italia":       ("Italia",       "Italy"),
    "Holanda":      ("Holanda",      "Netherlands"),
    "Inglaterra":   ("Inglaterra",   "UK"),
    "Belgica":      ("Belgica",      "Belgium"),
    "Costa Rica":   ("Costa Rica",   "Costa Rica"),
    "Brasil":       ("Brasil",       "Brazil"),
    "Colombia":     ("Colombia",     "Colombia"),
    "USA":          ("USA",          "USA"),
}

_CR_GEO_CATS = {"Turismo CR", "Voluntariados", "Paseos en automovil", "Paseos en bicicleta"}

_VISITAS_CITY_COUNTRY: dict[str, str] = {
    "Lourdes": "Francia", "Biarritz": "Francia",
    "Paris": "Francia",   "Lyon": "Francia",
    "Lisboa": "Portugal", "Porto": "Portugal",
}

def _extract_city_token_bi(folder: str) -> str | None:
    m = re.match(r'^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]+?)(?:\s*[-–]\s*|\s*\d)', folder)
    return m.group(1).strip() if m else None

def _system_tag_bi(rel_path: str) -> str | None:  # noqa: C901
    parts = PurePosixPath(rel_path).parts
    if not parts:
        return None

    # .Amigos
    if parts[0] == ".Amigos":
        if len(parts) < 4:
            return None
        country_city = parts[1]
        if " - " in country_city:
            country_folder, city = country_city.split(" - ", 1)
            person = parts[2]
        elif len(parts) >= 4 and " - " in parts[2]:
            country_folder = parts[1]
            city, person   = parts[2].split(" - ", 1)
        else:
            return None
        mapping = _AMIGOS_COUNTRY_MAP_BI.get(country_folder)
        if not mapping:
            return None
        country_es = mapping[0]
        if len(parts) >= 5 and " - " in parts[3]:
            album_name = parts[3]
            album_city = album_name.split(" - ", 1)[0].strip()
            if album_city:
                return f"{country_es}/{album_name}"
        return f"{country_es}/{city} - {person}"

    # .Whatsapp
    if parts[0] == ".Whatsapp":
        return "Costa Rica/Tibás - Whatsapp"

    if parts[0] != "Camera" or len(parts) < 3:
        return None

    dir_parts = list(parts[1:-1])
    if not dir_parts:
        return None
    tag_parts = dir_parts[1:] if dir_parts[0] in _GEO_CONTINENT_ROOTS else dir_parts

    # Visitas
    if len(tag_parts) >= 3 and tag_parts[0] == "Visitas":
        trip      = tag_parts[1]
        subfolder = tag_parts[2]
        if " - " in subfolder:
            country_es, city = subfolder.split(" - ", 1)
            if country_es in _COUNTRY_NORMALIZE_BI:
                return f"{country_es}/{city} - {trip}"
        else:
            country_es = _VISITAS_CITY_COUNTRY.get(subfolder, "España")
            return f"{country_es}/{subfolder}"

    # Costa Rica geo-cats
    if (len(tag_parts) >= 3 and tag_parts[0] == "Costa Rica"
            and tag_parts[1] in _CR_GEO_CATS):
        return f"Costa Rica/{tag_parts[2]}"
    if (len(tag_parts) >= 2 and tag_parts[0] == "Costa Rica"
            and tag_parts[1] in {"Familia", "Visitas"}):
        return None

    # "Country - City/..."
    if len(tag_parts) >= 1 and " - " in tag_parts[0]:
        country_cand = tag_parts[0].split(" - ")[0].strip()
        if country_cand in _COUNTRY_NORMALIZE_BI:
            return (f"{country_cand} - {tag_parts[1]}"
                    if len(tag_parts) >= 2 else tag_parts[0])

    # España: skip region level
    if len(tag_parts) >= 3 and tag_parts[0] == "España":
        return f"España/{tag_parts[2]}"

    # USA / Canada collapse
    if len(tag_parts) >= 3 and tag_parts[0] == "USA":
        city = _extract_city_token_bi(tag_parts[2]) or tag_parts[2]
        return f"USA/{city}"

    # Strip "person's pictures" sub-folder
    if len(tag_parts) >= 3 and tag_parts[2].lower().endswith(" pictures"):
        return "/".join(tag_parts[:2])

    # Collapse trip sub-folders; keep real place names
    if len(tag_parts) >= 3 and " - " in tag_parts[1]:
        sub       = tag_parts[2]
        sub_lower = sub.lower()
        if (re.match(r'^(Parte\s*\d+|\d+)$', sub, re.IGNORECASE)
                or '_' in sub
                or sub_lower in _NON_PLACE_SUBFOLDERS
                or sub_lower.startswith('fotos de ')):
            return "/".join(tag_parts[:2])
        return f"{tag_parts[0]}/{sub}"

    # Fallback with city-name normalisation
    if tag_parts:
        _CITY_FOLDER_NORMALIZE = {'Bruges': 'Brugge'}
        normalized = [tag_parts[0]] + [
            _CITY_FOLDER_NORMALIZE.get(p, p) for p in tag_parts[1:]
        ]
        return "/".join(normalized)
    return None


# ── Common-ancestor folder for a set of paths ────────────────────────────────

def _common_parent(paths: list[str]) -> str:
    """Return the deepest directory prefix shared by all paths."""
    if not paths:
        return ''
    split = [PurePosixPath(p).parts for p in paths]
    common: list[str] = []
    for group in zip(*split):
        if len(set(group)) == 1:
            common.append(group[0])
        else:
            break
    return str(PurePosixPath(*common)) + '/' if common else ''


# ── Main ─────────────────────────────────────────────────────────────────────

def generate(db_path: Path = DB_PATH,
             ts_path: Path = SYSTAGS_TS,
             out_path: Path = OUTPUT_CSV,
             photos_root: Path = PHOTOS_ROOT) -> int:
    coords = parse_coords(ts_path)

    con = sqlite3.connect(db_path)
    rows = con.execute(
        "SELECT current_path FROM photos WHERE status='active' AND s3_uploaded=1"
    ).fetchall()
    con.close()

    # Collect unique immediate-parent folders per sys_tag
    tag_to_rel_dirs: dict[str, set[str]] = defaultdict(set)
    for (path,) in rows:
        tag = _system_tag_bi(path)
        if not tag:
            continue
        rel_dir = '/'.join(path.replace('\\', '/').split('/')[:-1])
        tag_to_rel_dirs[tag].add(rel_dir)

    written = 0
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Tag title', 'HD folder', 'Geographical coordinates'])

        for tag in sorted(tag_to_rel_dirs.keys()):
            country   = _country_key(tag)
            city      = _city_key(tag)
            coord     = _lookup_coords(country, city, coords)
            coord_str = f'{coord[0]};{coord[1]}' if coord else ''

            # One row per unique immediate-parent folder, sorted
            for rel_dir in sorted(tag_to_rel_dirs[tag]):
                hd_folder = str(photos_root / rel_dir) + '/'
                writer.writerow([tag, hd_folder, coord_str])
                written += 1

    return written


if __name__ == '__main__':
    n = generate()
    print(f"coordinates.csv written — {n} rows")
