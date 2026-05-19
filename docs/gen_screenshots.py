#!/usr/bin/env python3
"""Generate dummy screenshot SVGs for photo-visor README."""

import os, textwrap

OUT = os.path.join(os.path.dirname(__file__), "screenshots")
os.makedirs(OUT, exist_ok=True)

W, H = 1200, 720
HEADER_H = 52
CONTENT_Y = HEADER_H + 1

BG        = "#0f172a"
HDR       = "#1e293b"
CARD      = "#243044"
BORDER    = "#334155"
ACCENT    = "#ff0084"
PRIMARY   = "#f1f5f9"
SECONDARY = "#94a3b8"
DIM       = "#64748b"
FONT      = "system-ui, -apple-system, Arial, sans-serif"

# (sky, mountain, ground) palettes for dummy photo tiles
PALETTES = [
    ("#3b82f6", "#1e3a5f", "#166534"),
    ("#f97316", "#92400e", "#78350f"),
    ("#10b981", "#065f46", "#064e3b"),
    ("#1e1b4b", "#4338ca", "#1e3a5f"),
    ("#fcd34d", "#b45309", "#92400e"),
    ("#e0f2fe", "#bfdbfe", "#93c5fd"),
    ("#8b5cf6", "#4c1d95", "#2d1b69"),
    ("#34d399", "#065f46", "#047857"),
    ("#fbbf24", "#b45309", "#92400e"),
    ("#60a5fa", "#1d4ed8", "#1e3a5f"),
]

TABS = [
    ("map",      "Map"),
    ("timeline", "Timeline"),
    ("tags",     "Tags"),
    ("latest",   "Latest"),
    ("slots",    "Slots"),
    ("stats",    "Stats"),
    ("upload",   "Upload"),
]

# ── helpers ──────────────────────────────────────────────────────────────────

def header(active: str) -> str:
    x = 120
    tab_els = []
    for key, label in TABS:
        is_active = key == active
        fill = ACCENT if is_active else SECONDARY
        weight = "600" if is_active else "400"
        tab_els.append(
            f'<text x="{x}" y="32" font-family="{FONT}" font-size="13.5" '
            f'fill="{fill}" font-weight="{weight}">{label}</text>'
        )
        if is_active:
            tab_els.append(
                f'<rect x="{x}" y="49" width="{len(label)*8}" height="3" fill="{ACCENT}" rx="1"/>'
            )
        x += len(label) * 8 + 22
    tabs_svg = "\n  ".join(tab_els)

    return f"""
  <rect x="0" y="0" width="{W}" height="{HEADER_H}" fill="{HDR}"/>
  <rect x="0" y="{HEADER_H}" width="{W}" height="1" fill="{BORDER}"/>
  <text x="18" y="34" font-family="{FONT}" font-size="20" font-weight="700" fill="{ACCENT}">foto</text>
  <text x="60" y="34" font-family="{FONT}" font-size="20" font-weight="700" fill="{PRIMARY}">visor</text>
  {tabs_svg}
  <text x="950" y="32" font-family="{FONT}" font-size="12.5" fill="{SECONDARY}">EN / ES</text>
  <text x="1000" y="32" font-family="{FONT}" font-size="12.5" fill="{SECONDARY}">john.doe@example.com</text>
  <rect x="1158" y="14" width="30" height="22" rx="4" fill="{BORDER}"/>
  <text x="1163" y="29" font-family="{FONT}" font-size="11" fill="{SECONDARY}">Exit</text>
"""

def photo(x, y, w, h, idx=0, rx=4) -> str:
    sky, mtn, gnd = PALETTES[idx % len(PALETTES)]
    bx, by = x, y
    bw, bh = w, h
    m = [
        (bx,              by + bh),
        (bx + bw * 0.10, by + bh),
        (bx + bw * 0.30, by + bh * 0.42),
        (bx + bw * 0.50, by + bh * 0.55),
        (bx + bw * 0.68, by + bh * 0.32),
        (bx + bw * 0.85, by + bh * 0.50),
        (bx + bw,        by + bh),
    ]
    pts = " ".join(f"{px:.1f},{py:.1f}" for px, py in m)
    sun_cx = bx + bw * 0.78
    sun_cy = by + bh * 0.22
    sun_r  = min(bw, bh) * 0.10
    clip_id = f"clip_{x}_{y}".replace(".", "_").replace("-", "n")
    return (
        f'<clipPath id="{clip_id}"><rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="{rx}"/></clipPath>'
        f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="{rx}" fill="{sky}"/>'
        f'<polygon points="{pts}" fill="{mtn}" clip-path="url(#{clip_id})"/>'
        f'<rect x="{bx}" y="{by + bh*0.80:.1f}" width="{bw}" height="{bh*0.20:.1f}" fill="{gnd}" clip-path="url(#{clip_id})"/>'
        f'<circle cx="{sun_cx:.1f}" cy="{sun_cy:.1f}" r="{sun_r:.1f}" fill="rgba(255,230,80,0.75)" clip-path="url(#{clip_id})"/>'
    )

def grid_of_photos(x, y, cols, rows, cell_w, cell_h, gap=8, start_idx=0) -> str:
    parts = []
    idx = start_idx
    for row in range(rows):
        for col in range(cols):
            px = x + col * (cell_w + gap)
            py = y + row * (cell_h + gap)
            parts.append(photo(px, py, cell_w, cell_h, idx))
            idx += 1
    return "\n".join(parts)

def svg_wrap(content: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}">\n'
        f'  <rect width="{W}" height="{H}" fill="{BG}"/>\n'
        f'{content}\n'
        '</svg>\n'
    )

def write(name: str, content: str):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        f.write(svg_wrap(content))
    print(f"  wrote {path}")

# ── 1. Map ────────────────────────────────────────────────────────────────────

def gen_map():
    # Simplified world map using polygons
    ocean = "#0d2137"
    land  = "#1f3d2e"
    land2 = "#254a38"

    continents = {
        "N America": "145,155 280,130 320,165 310,240 270,280 210,290 160,260 130,210",
        "S America": "215,300 285,295 305,360 300,435 270,470 225,455 205,375",
        "Europe":    "470,115 555,108 578,145 560,185 520,195 488,175 462,145",
        "Africa":    "468,200 565,198 592,295 582,390 530,435 478,400 456,310",
        "Asia":      "565,100 870,95 920,155 900,260 840,310 750,320 650,270 590,200 568,145",
        "Australia": "840,415 960,400 985,465 960,510 890,525 850,480",
        "Greenland": "215,62 295,58 318,110 270,135 202,115",
    }
    cont_svg = "\n  ".join(
        f'<polygon points="{pts}" fill="{land}" opacity="0.9"/>'
        for pts in continents.values()
    )

    # Photo clusters (lat/lon → approximate pixel)
    clusters = [
        (490, 135, 12, "38", "#ff0084"),   # Europe big
        (510, 290, 9,  "14", "#f97316"),   # East Africa
        (700, 170, 10, "22", "#3b82f6"),   # India
        (820, 200, 8,  "9",  "#10b981"),   # China
        (190, 195, 9,  "17", "#8b5cf6"),   # USA
        (246, 350, 6,  "6",  "#fbbf24"),   # Brazil
        (900, 440, 5,  "4",  "#ec4899"),   # Australia
        (160, 145, 5,  "3",  "#14b8a6"),   # Canada
    ]
    cluster_svg = []
    for cx, cy, r, label, color in clusters:
        cluster_svg.append(
            f'<circle cx="{cx}" cy="{cy+CONTENT_Y}" r="{r}" fill="{color}" opacity="0.9"/>'
            f'<text x="{cx}" y="{cy+CONTENT_Y+4}" text-anchor="middle" font-family="{FONT}" '
            f'font-size="9" fill="white" font-weight="700">{label}</text>'
        )

    # Info panel bottom-right
    panel_x, panel_y, panel_w, panel_h = 950, 580, 230, 110
    panel_svg = f"""
  <rect x="{panel_x}" y="{panel_y}" width="{panel_w}" height="{panel_h}" rx="8" fill="{CARD}" opacity="0.95" stroke="{BORDER}" stroke-width="1"/>
  <text x="{panel_x+14}" y="{panel_y+26}" font-family="{FONT}" font-size="13" fill="{PRIMARY}" font-weight="600">Photo locations</text>
  <text x="{panel_x+14}" y="{panel_y+48}" font-family="{FONT}" font-size="12" fill="{SECONDARY}">194 754 photos</text>
  <text x="{panel_x+14}" y="{panel_y+66}" font-family="{FONT}" font-size="12" fill="{SECONDARY}">47 countries · 312 cities</text>
  <text x="{panel_x+14}" y="{panel_y+88}" font-family="{FONT}" font-size="11" fill="{DIM}">Click a cluster to open album</text>
"""

    content = (
        header("map")
        + f'  <rect x="0" y="{CONTENT_Y}" width="{W}" height="{H-CONTENT_Y}" fill="{ocean}"/>\n'
        + f"  {cont_svg}\n"
        + "  " + "\n  ".join(cluster_svg) + "\n"
        + panel_svg
    )
    write("01_map.svg", content)

# ── 2. Timeline ───────────────────────────────────────────────────────────────

def gen_timeline():
    # Year buttons
    years = ["2015", "2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"]
    active_year = "2021"
    year_y = CONTENT_Y + 18
    year_els = []
    x = 20
    for yr in years:
        is_active = yr == active_year
        bg = ACCENT if is_active else CARD
        tc = "white" if is_active else SECONDARY
        year_els.append(
            f'<rect x="{x}" y="{year_y}" width="60" height="28" rx="14" fill="{bg}"/>'
            f'<text x="{x+30}" y="{year_y+19}" text-anchor="middle" font-family="{FONT}" '
            f'font-size="13" fill="{tc}" font-weight="{"600" if is_active else "400"}">{yr}</text>'
        )
        x += 72
    year_svg = "\n  ".join(year_els)

    # Month grid
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    active_month = "Aug"
    m_y = year_y + 46
    month_els = []
    for i, mo in enumerate(months):
        mx = 20 + i * 90
        is_a = mo == active_month
        bg = ACCENT if is_a else CARD
        tc = "white" if is_a else SECONDARY
        count = [341,298,412,387,455,523,611,748,502,389,274,198][i]
        month_els.append(
            f'<rect x="{mx}" y="{m_y}" width="80" height="52" rx="6" fill="{bg}" stroke="{BORDER}" stroke-width="1"/>'
            f'<text x="{mx+40}" y="{m_y+22}" text-anchor="middle" font-family="{FONT}" font-size="13" fill="{tc}" font-weight="{"600" if is_a else "400"}">{mo}</text>'
            f'<text x="{mx+40}" y="{m_y+40}" text-anchor="middle" font-family="{FONT}" font-size="10" fill="{tc}" opacity="0.8">{count}</text>'
        )
    month_svg = "\n  ".join(month_els)

    # Photo grid (selected month)
    label_y = m_y + 70
    label_svg = (
        f'<text x="20" y="{label_y}" font-family="{FONT}" font-size="14" fill="{PRIMARY}" font-weight="600">'
        f'August 2021 — 748 photos</text>'
    )
    grid_y = label_y + 12
    grid_svg = grid_of_photos(20, grid_y, 9, 4, 126, 95, gap=6, start_idx=0)

    content = (
        header("timeline")
        + f"  {year_svg}\n"
        + f"  {month_svg}\n"
        + f"  {label_svg}\n"
        + f"  {grid_svg}\n"
    )
    write("02_timeline.svg", content)

# ── 3. Tags ───────────────────────────────────────────────────────────────────

def gen_tags():
    # Left panel: tag list
    LP_W = 260
    tag_data = [
        ("beach",     "🏖", 127, True),
        ("family",    "👨‍👩‍👧", 342, False),
        ("travel",    "✈",  89, False),
        ("birthday",  "🎂", 54,  False),
        ("hiking",    "🥾", 76,  False),
        ("christmas", "🎄", 38,  False),
        ("dogs",      "🐶", 21,  False),
        ("concerts",  "🎵", 17,  False),
        ("food",      "🍕", 63,  False),
        ("wedding",   "💍", 12,  False),
    ]
    panel_bg = CARD
    tag_els = [
        f'<rect x="0" y="{CONTENT_Y}" width="{LP_W}" height="{H-CONTENT_Y}" fill="{panel_bg}"/>',
        f'<rect x="{LP_W}" y="{CONTENT_Y}" width="1" height="{H-CONTENT_Y}" fill="{BORDER}"/>',
        f'<text x="16" y="{CONTENT_Y+28}" font-family="{FONT}" font-size="14" fill="{PRIMARY}" font-weight="600">My Tags</text>',
    ]
    # search bar
    tag_els.append(
        f'<rect x="10" y="{CONTENT_Y+40}" width="{LP_W-20}" height="28" rx="6" fill="{BG}" stroke="{BORDER}" stroke-width="1"/>'
        f'<text x="20" y="{CONTENT_Y+58}" font-family="{FONT}" font-size="12" fill="{DIM}">Search tags…</text>'
    )
    for i, (tag, icon, count, active) in enumerate(tag_data):
        ty = CONTENT_Y + 78 + i * 46
        bg2 = f'{ACCENT}22' if active else "transparent"
        lc  = ACCENT if active else PRIMARY
        tag_els += [
            f'<rect x="6" y="{ty}" width="{LP_W-12}" height="38" rx="6" fill="{bg2}"/>',
            f'<text x="18" y="{ty+24}" font-family="{FONT}" font-size="13" fill="{lc}" font-weight="{"600" if active else "400"}">{icon} {tag}</text>',
            f'<text x="{LP_W-18}" y="{ty+24}" text-anchor="end" font-family="{FONT}" font-size="11" fill="{DIM}">{count}</text>',
        ]

    # Right panel: photo grid for selected tag
    grid_x = LP_W + 14
    label_y = CONTENT_Y + 18
    label_svg = (
        f'<text x="{grid_x}" y="{label_y}" font-family="{FONT}" font-size="14" fill="{PRIMARY}" font-weight="600">'
        f'beach — 127 photos</text>'
    )
    grid_svg = grid_of_photos(grid_x, label_y + 10, 5, 4, 178, 134, gap=8, start_idx=0)

    content = header("tags") + "\n".join(tag_els) + f"\n  {label_svg}\n  {grid_svg}\n"
    write("03_tags.svg", content)

# ── 4. Latest ────────────────────────────────────────────────────────────────

def gen_latest():
    section_labels = [
        ("Recently Added", "Last 24 h · 12 photos"),
        ("Recently Tagged", "Last 7 days · 8 tags"),
        ("Recently Commented", "Last 7 days · 5 comments"),
    ]
    parts = [header("latest")]

    y = CONTENT_Y + 14
    for sec_i, (title, sub) in enumerate(section_labels):
        parts.append(
            f'<text x="20" y="{y+4}" font-family="{FONT}" font-size="14" fill="{PRIMARY}" font-weight="600">{title}</text>'
            f'<text x="20" y="{y+20}" font-family="{FONT}" font-size="11" fill="{DIM}">{sub}</text>'
        )
        # Row of 6 photos
        row_svg = ""
        for j in range(6):
            px = 20 + j * 190
            row_svg += photo(px, y + 28, 178, 134, idx=sec_i * 6 + j)
        parts.append(row_svg)
        y += 28 + 134 + 20

    content = "\n".join(parts)
    write("04_latest.svg", content)

# ── 5. Slot Machine ───────────────────────────────────────────────────────────

def gen_slots():
    parts = [header("slots")]

    title_y = CONTENT_Y + 22
    parts.append(
        f'<text x="{W//2}" y="{title_y}" text-anchor="middle" font-family="{FONT}" '
        f'font-size="22" fill="{PRIMARY}" font-weight="700">Random Discovery</text>'
        f'<text x="{W//2}" y="{title_y+22}" text-anchor="middle" font-family="{FONT}" '
        f'font-size="13" fill="{SECONDARY}">Spin to discover forgotten memories</text>'
    )

    # Slot machine frame
    frame_x, frame_y = 40, title_y + 44
    frame_w, frame_h = W - 80, 460
    parts.append(
        f'<rect x="{frame_x}" y="{frame_y}" width="{frame_w}" height="{frame_h}" '
        f'rx="16" fill="{CARD}" stroke="{BORDER}" stroke-width="1"/>'
    )

    # 10 reels
    reel_w  = 100
    reel_h  = 350
    reel_gap = (frame_w - 10 * reel_w) // 11
    reel_y   = frame_y + 20

    for i in range(10):
        rx = frame_x + reel_gap + i * (reel_w + reel_gap)
        # Reel frame
        parts.append(
            f'<rect x="{rx}" y="{reel_y}" width="{reel_w}" height="{reel_h}" '
            f'rx="8" fill="{BG}" stroke="{BORDER}" stroke-width="1"/>'
        )
        # 3 photo tiles per reel (top/center/bottom)
        tile_h = (reel_h - 16) // 3
        for row in range(3):
            ty = reel_y + 6 + row * (tile_h + 2)
            is_center = row == 1
            border_color = ACCENT if is_center else "transparent"
            tile_svg  = photo(rx + 4, ty, reel_w - 8, tile_h - 2, idx=i * 3 + row, rx=6)
            parts.append(tile_svg)
            if is_center:
                parts.append(
                    f'<rect x="{rx+4}" y="{ty}" width="{reel_w-8}" height="{tile_h-2}" '
                    f'rx="6" fill="none" stroke="{ACCENT}" stroke-width="2"/>'
                )

    # Highlight bar across center
    bar_y = reel_y + 8 + reel_h // 3
    bar_h = reel_h // 3 - 4
    parts.append(
        f'<rect x="{frame_x+8}" y="{bar_y}" width="{frame_w-16}" height="{bar_h}" '
        f'fill="{ACCENT}" opacity="0.07" rx="4"/>'
    )

    # Spin button
    btn_y = frame_y + frame_h - 52
    btn_w, btn_h = 180, 40
    btn_x = frame_x + (frame_w - btn_w) // 2
    parts.append(
        f'<rect x="{btn_x}" y="{btn_y}" width="{btn_w}" height="{btn_h}" rx="20" fill="{ACCENT}"/>'
        f'<text x="{btn_x + btn_w//2}" y="{btn_y + 26}" text-anchor="middle" '
        f'font-family="{FONT}" font-size="15" fill="white" font-weight="700">Spin</text>'
    )

    content = "\n".join(parts)
    write("05_slots.svg", content)

# ── 6. Statistics ─────────────────────────────────────────────────────────────

def gen_stats():
    parts = [header("stats")]

    # Stat cards row
    card_data = [
        ("194 754", "Total Photos"),
        ("475 GB", "Storage Used"),
        ("47", "Countries"),
        ("~$2.42", "Monthly Cost"),
        ("10 years", "Time Covered"),
        ("312", "Cities"),
    ]
    CARD_W, CARD_H = 176, 76
    CARD_GAP = 16
    row_x = 20
    row_y = CONTENT_Y + 14
    for i, (val, label) in enumerate(card_data):
        cx = row_x + i * (CARD_W + CARD_GAP)
        parts.append(
            f'<rect x="{cx}" y="{row_y}" width="{CARD_W}" height="{CARD_H}" rx="8" fill="{CARD}" stroke="{BORDER}" stroke-width="1"/>'
            f'<text x="{cx+14}" y="{row_y+30}" font-family="{FONT}" font-size="22" fill="{ACCENT}" font-weight="700">{val}</text>'
            f'<text x="{cx+14}" y="{row_y+52}" font-family="{FONT}" font-size="12" fill="{SECONDARY}">{label}</text>'
        )

    # Bar chart: Photos per year
    chart_x, chart_y = 20, row_y + CARD_H + 24
    chart_w, chart_h = 540, 260
    parts.append(
        f'<rect x="{chart_x}" y="{chart_y}" width="{chart_w}" height="{chart_h}" rx="8" fill="{CARD}" stroke="{BORDER}" stroke-width="1"/>'
        f'<text x="{chart_x+14}" y="{chart_y+24}" font-family="{FONT}" font-size="13" fill="{PRIMARY}" font-weight="600">Photos per Year</text>'
    )
    year_counts = [1234, 3456, 8901, 12345, 18900, 22400, 31200, 28700, 34500, 32119]
    years_label = list(range(2015, 2025))
    max_c = max(year_counts)
    bar_area_x = chart_x + 40
    bar_area_y = chart_y + 36
    bar_area_w = chart_w - 60
    bar_area_h = chart_h - 60
    bar_w = bar_area_w // len(year_counts) - 6

    for i, (yr, cnt) in enumerate(zip(years_label, year_counts)):
        bh = int(bar_area_h * cnt / max_c)
        bx = bar_area_x + i * (bar_w + 6)
        by = bar_area_y + bar_area_h - bh
        parts.append(
            f'<rect x="{bx}" y="{by}" width="{bar_w}" height="{bh}" rx="3" fill="{ACCENT}" opacity="0.8"/>'
            f'<text x="{bx + bar_w//2}" y="{bar_area_y + bar_area_h + 15}" text-anchor="middle" '
            f'font-family="{FONT}" font-size="10" fill="{DIM}">{yr}</text>'
        )

    # Pie chart: Top countries
    import math
    pie_x, pie_y = chart_x + chart_w + 20, chart_y
    pie_w, pie_h = W - pie_x - 20, chart_h
    parts.append(
        f'<rect x="{pie_x}" y="{pie_y}" width="{pie_w}" height="{pie_h}" rx="8" fill="{CARD}" stroke="{BORDER}" stroke-width="1"/>'
        f'<text x="{pie_x+14}" y="{pie_y+24}" font-family="{FONT}" font-size="13" fill="{PRIMARY}" font-weight="600">Top Countries</text>'
    )
    country_data = [
        ("Spain", 0.35, ACCENT),
        ("Colombia", 0.22, "#3b82f6"),
        ("France", 0.12, "#10b981"),
        ("USA", 0.10, "#f97316"),
        ("Italy", 0.08, "#8b5cf6"),
        ("Other", 0.13, "#64748b"),
    ]
    cx_center = pie_x + pie_w // 2 - 30
    cy_center = pie_y + pie_h // 2 + 10
    pr = 80
    start_angle = -math.pi / 2
    for country, fraction, color in country_data:
        end_angle = start_angle + fraction * 2 * math.pi
        lx1 = cx_center + pr * math.cos(start_angle)
        ly1 = cy_center + pr * math.sin(start_angle)
        lx2 = cx_center + pr * math.cos(end_angle)
        ly2 = cy_center + pr * math.sin(end_angle)
        large = 1 if fraction > 0.5 else 0
        parts.append(
            f'<path d="M{cx_center},{cy_center} L{lx1:.1f},{ly1:.1f} A{pr},{pr} 0 {large},1 {lx2:.1f},{ly2:.1f} Z" fill="{color}" opacity="0.85"/>'
        )
        start_angle = end_angle

    # Legend
    leg_x = cx_center + pr + 16
    for i, (country, fraction, color) in enumerate(country_data):
        ly = pie_y + 46 + i * 28
        parts.append(
            f'<rect x="{leg_x}" y="{ly}" width="12" height="12" rx="3" fill="{color}"/>'
            f'<text x="{leg_x+18}" y="{ly+11}" font-family="{FONT}" font-size="11.5" fill="{PRIMARY}">'
            f'{country} ({fraction*100:.0f}%)</text>'
        )

    content = "\n".join(parts)
    write("06_stats.svg", content)

# ── 7. Upload ─────────────────────────────────────────────────────────────────

def gen_upload():
    parts = [header("upload")]

    center_x = W // 2
    zone_y = CONTENT_Y + 30
    zone_w, zone_h = 600, 200
    zone_x = center_x - zone_w // 2

    # Drop zone
    parts.append(
        f'<rect x="{zone_x}" y="{zone_y}" width="{zone_w}" height="{zone_h}" rx="12" '
        f'fill="{CARD}" stroke="{ACCENT}" stroke-width="2" stroke-dasharray="8,5"/>'
        f'<!-- upload icon (arrow up) -->'
        f'<text x="{center_x}" y="{zone_y + 80}" text-anchor="middle" '
        f'font-family="{FONT}" font-size="44" fill="{ACCENT}" opacity="0.7">↑</text>'
        f'<text x="{center_x}" y="{zone_y + 118}" text-anchor="middle" '
        f'font-family="{FONT}" font-size="16" fill="{PRIMARY}" font-weight="600">Drop photos here</text>'
        f'<text x="{center_x}" y="{zone_y + 140}" text-anchor="middle" '
        f'font-family="{FONT}" font-size="13" fill="{SECONDARY}">or click to select files</text>'
        f'<text x="{center_x}" y="{zone_y + 162}" text-anchor="middle" '
        f'font-family="{FONT}" font-size="11" fill="{DIM}">JPEG · HEIC · PNG · MP4 · MOV</text>'
    )

    # File queue list
    files = [
        ("IMG_2024_08_14_001.jpg", "3.2 MB",  100, "#10b981"),
        ("IMG_2024_08_14_002.jpg", "2.8 MB",  100, "#10b981"),
        ("IMG_2024_08_14_003.heic","4.1 MB",   67, ACCENT),
        ("VID_2024_08_14_001.mp4", "18.4 MB",  33, "#3b82f6"),
        ("IMG_2024_08_14_004.jpg", "2.3 MB",    0, BORDER),
    ]
    list_x = zone_x
    list_y = zone_y + zone_h + 24
    list_w = zone_w

    parts.append(
        f'<text x="{list_x}" y="{list_y}" font-family="{FONT}" font-size="13" '
        f'fill="{PRIMARY}" font-weight="600">Upload queue — 5 files</text>'
    )

    for i, (fname, size, progress, color) in enumerate(files):
        fy = list_y + 16 + i * 52
        parts.append(
            f'<rect x="{list_x}" y="{fy}" width="{list_w}" height="44" rx="6" fill="{CARD}" stroke="{BORDER}" stroke-width="1"/>'
        )
        # thumbnail placeholder
        thumb_idx = i
        parts.append(photo(list_x + 6, fy + 4, 56, 36, idx=thumb_idx, rx=4))
        # filename
        parts.append(
            f'<text x="{list_x+72}" y="{fy+18}" font-family="{FONT}" font-size="12" fill="{PRIMARY}">{fname}</text>'
            f'<text x="{list_x+72}" y="{fy+33}" font-family="{FONT}" font-size="11" fill="{DIM}">{size}</text>'
        )
        # progress bar
        pb_x = list_x + 72
        pb_y = fy + 38
        pb_w = list_w - 80
        parts.append(
            f'<rect x="{pb_x}" y="{pb_y}" width="{pb_w}" height="4" rx="2" fill="{BORDER}"/>'
            f'<rect x="{pb_x}" y="{pb_y}" width="{pb_w * progress // 100}" height="4" rx="2" fill="{color}"/>'
        )
        if progress == 100:
            parts.append(
                f'<text x="{list_x + list_w - 6}" y="{fy+20}" text-anchor="end" '
                f'font-family="{FONT}" font-size="18" fill="#10b981">✓</text>'
            )

    content = "\n".join(parts)
    write("07_upload.svg", content)

# ── main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Generating SVG screenshots...")
    gen_map()
    gen_timeline()
    gen_tags()
    gen_latest()
    gen_slots()
    gen_stats()
    gen_upload()
    print("Done.")
