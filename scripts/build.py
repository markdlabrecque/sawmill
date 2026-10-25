"""Build the standalone Sawmill marketing page using Python's standard library."""
from pathlib import Path
import base64
import re

root = Path(__file__).resolve().parent.parent
assets = root / "assets"
html = (root / "src/index.html").read_text()

symbol = re.search(r'<symbol id="saw-mark" viewBox="0 0 100 100">(.*?)</symbol>', html).group(1)
for name, color, cut in [("mark", "#214538", "#f5f0df"), ("mark-reversed", "#f5f0df", "#214538")]:
    paths = symbol.replace("currentColor", color).replace("var(--logo-cut,#f5f0df)", cut)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Sawmill">' + paths + '</svg>'
    (assets / ("sawmill-" + name + ".svg")).write_text(svg)

fonts = ""
for name, family, weight in [("display", "Mill Display", "700 900"), ("body-regular", "Mill Body", "400 500"), ("body-semibold", "Mill Body", "600 700")]:
    data = base64.b64encode((assets / (name + ".woff2")).read_bytes()).decode()
    fonts += f"@font-face{{font-family:'{family}';src:url(data:font/woff2;base64,{data}) format('woff2');font-weight:{weight};font-style:normal;font-display:swap;}}\n"
html = html.replace("/* FONT_FACES */", fonts)
favicon = base64.b64encode((assets / "sawmill-mark.svg").read_bytes()).decode()
html = html.replace('<meta name="theme-color"', '<link rel="icon" href="data:image/svg+xml;base64,' + favicon + '">\n  <meta name="theme-color"')
html = html.replace("MASCOT_SOURCE", "data:image/png;base64," + base64.b64encode((assets / "timber-mascot.png").read_bytes()).decode())
html = html.replace("<!-- SCROLLCRAFT_ENGINE -->", "<script>" + (assets / "scrollcraft.js").read_text() + "</script>")
(root / "index.html").write_text(html)
print("Built index.html with embedded fonts, illustrations, and scripts.")
