"""Build the page and SVGs; --logo-kit also renders PNGs and packages the kit."""
from pathlib import Path
import argparse
import base64
import re
import shutil
import struct
import subprocess
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--logo-kit", action="store_true", help="Render PNGs with rsvg-convert and rebuild the ZIP")
args = parser.parse_args()
if args.logo_kit and not shutil.which("rsvg-convert"):
    parser.error("--logo-kit requires rsvg-convert from librsvg")

root = Path(__file__).resolve().parent.parent
assets = root / "assets"
source = root / "src"


def svg_body(svg):
    body = re.sub(r"^<svg\b[^>]*>|</svg>\s*$", "", svg.strip())
    return re.sub(r"<title>.*?</title>", "", body)


def svg_document(body, width=100):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 100" role="img" aria-label="Sawmill">{body}</svg>\n'


mark = (source / "sawmill-mark.svg").read_text()
body = svg_body(mark)
reverse = re.sub(r"#214538|#f5f0df", lambda m: {"#214538": "#f5f0df", "#f5f0df": "#214538"}[m[0]], body)
lettering = (source / "sawmill-lettering.svg").read_text()
wordmark_width = re.search(r'viewBox="0 0 ([\d.]+) 100"', lettering)[1]
lettering_body = svg_body(lettering)
variants = {"mark": mark, "mark-reversed": svg_document(reverse)}
for name, color in [("mono", "#214538"), ("mono-light", "#f5f0df")]:
    # One ink: letter and depth are transparent, their outlines retain the ink.
    mask_body = re.sub(r"#214538|#000000|#f5f0df|#ffffff", lambda m: "#ffffff" if m[0] in ("#214538", "#000000") else "#000000", body)
    mask = f'<defs><mask id="{name}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" style="mask-type:luminance">{mask_body}</mask></defs>'
    variants[name] = svg_document(mask + f'<rect width="100" height="100" fill="{color}" mask="url(#{name})"/>')
for name, mark_body, color in [("wordmark", body, "#214538"), ("wordmark-reversed", reverse, "#f5f0df")]:
    variants[name] = svg_document(mark_body + f'<g fill="{color}">{lettering_body}</g>', wordmark_width)
for name, svg in variants.items():
    (assets / f"sawmill-{name}.svg").write_text(svg)

if args.logo_kit:
    pngs = []
    for name in variants:
        width = 2048 if name.startswith("wordmark") else 1024
        target = assets / f"sawmill-{name}.png"
        subprocess.run(["rsvg-convert", "-w", str(width), "-o", str(target), str(assets / f"sawmill-{name}.svg")], check=True)
        pngs.append(target)
    for width in (256, 512, 2048):
        target = assets / f"sawmill-mark-{width}.png"
        subprocess.run(["rsvg-convert", "-w", str(width), "-o", str(target), str(assets / "sawmill-mark.svg")], check=True)
        pngs.append(target)
    files = {f"svg/sawmill-{name}.svg": assets / f"sawmill-{name}.svg" for name in variants}
    files.update({f"png/{path.name}": path for path in pngs})
    files["README.txt"] = source / "logo-kit-README.txt"
    files["font-LICENSE.txt"] = assets / "barlow-LICENSE.txt"
    with zipfile.ZipFile(assets / "sawmill-logo-kit.zip", "w") as bundle:
        for name, path in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            bundle.writestr(entry, path.read_bytes())
    print("Built six SVGs, nine transparent PNGs, and sawmill-logo-kit.zip.")

html = (source / "index.html").read_text()
symbol = body.replace("#214538", "currentColor").replace("#f5f0df", "var(--logo-cut,#f5f0df)")
html = html.replace("<!-- SAWMILL_LOGO_SYMBOL -->", '<symbol id="saw-mark" viewBox="0 0 100 100"><g stroke="none">' + symbol + '</g></symbol>')
fonts = ""
for name, family, weight in [("display", "Mill Display", "700 900"), ("body-regular", "Mill Body", "400 500"), ("body-semibold", "Mill Body", "600 700")]:
    data = base64.b64encode((assets / (name + ".woff2")).read_bytes()).decode()
    fonts += f"@font-face{{font-family:'{family}';src:url(data:font/woff2;base64,{data}) format('woff2');font-weight:{weight};font-style:normal;font-display:swap;}}\n"
html = html.replace("/* FONT_FACES */", fonts)
favicon = base64.b64encode(mark.encode()).decode()
html = html.replace('<meta name="theme-color"', '<link rel="icon" href="data:image/svg+xml;base64,' + favicon + '">\n  <meta name="theme-color"')
html = html.replace("MASCOT_SOURCE", "data:image/png;base64," + base64.b64encode((assets / "timber-mascot.png").read_bytes()).decode())
for size in ("desktop", "mobile"):
    png = (assets / f"board-{size}.png").read_bytes()
    width, height = struct.unpack(">II", png[16:24])
    image = base64.b64encode(png).decode()
    html = html.replace(f"BOARD_{size.upper()}_SOURCE", "data:image/png;base64," + image)
    html = html.replace(f"BOARD_{size.upper()}_WIDTH", str(width)).replace(f"BOARD_{size.upper()}_HEIGHT", str(height))
html = html.replace("<!-- SCROLLCRAFT_ENGINE -->", "<script>" + (assets / "scrollcraft.js").read_text() + "</script>")
(root / "index.html").write_text(html)
print("Built index.html with embedded fonts, illustrations, and scripts.")
