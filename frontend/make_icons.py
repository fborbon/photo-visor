from PIL import Image, ImageDraw
import os

os.makedirs("public/icons", exist_ok=True)

for size in (192, 512):
    img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    r    = size // 8
    # Background rounded rect
    draw.rounded_rectangle([0, 0, size-1, size-1], radius=size//7, fill=(15, 15, 15, 255))
    # Camera body
    pad  = size // 8
    cx, cy = size // 2, size * 6 // 10
    bw   = size - pad * 2
    bh   = size * 5 // 10
    by   = cy - bh // 2
    draw.rounded_rectangle([pad, by, pad+bw, by+bh], radius=size//14, outline=(59,130,246,255), width=max(2, size//30))
    # Lens
    lr = size // 5
    draw.ellipse([cx-lr, cy-lr, cx+lr, cy+lr], outline=(59,130,246,255), width=max(2, size//30))
    lr2 = size // 10
    draw.ellipse([cx-lr2, cy-lr2, cx+lr2, cy+lr2], fill=(59,130,246,255))
    # Shutter bump
    bx, bby = size * 5 // 14, by - size // 14
    draw.rounded_rectangle([bx, bby, bx + size // 5, by + size // 30], radius=size // 24, fill=(59,130,246,255))
    img.save(f"public/icons/icon-{size}.png")
    print(f"Created icon-{size}.png")
