import time
from tqdm import tqdm

total = 189612
bar_fmt = "  Scanning  {n:>7,} / " + str(total) + "  [{elapsed}<{remaining}  {rate_fmt}]"

for i in tqdm(range(total), bar_format=bar_fmt, unit="file"):
    if i == 50:
        break
    time.sleep(0.01)
