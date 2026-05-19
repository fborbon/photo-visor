import json, sys
d = json.load(sys.stdin)
print("total       :", d["total"])
print("years       :", sorted(d["years"]))
print("locations   :", len(d["locations"]))
print("gen folders :", len(d["general_folders"]))
print("sample locs :")
for loc in d["locations"][:5]:
    print("  ", loc["country"], "/", loc["city"], "–", loc["count"], "photos  lat", loc["lat"])
