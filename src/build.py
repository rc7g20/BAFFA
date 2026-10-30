"""把 src/ 的原始碼組成單一檔案的 index.html（不需任何外部函式庫，可離線使用）。

用法：python src/build.py            → 產生 index.html（儲存庫根目錄）
      python src/build.py 輸出檔.html
"""
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
t = open(os.path.join(here, "template.html"), encoding="utf-8").read()
for key, fn in [("XLSX", "xlsx.js"), ("CORE", "core.js"), ("CHARTS", "charts.js"), ("UI", "ui.js")]:
    t = t.replace(f"<script>/*{key}*/</script>", "<script>\n" + open(os.path.join(here, fn), encoding="utf-8").read() + "\n</script>")
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(here), "index.html")
open(out, "w", encoding="utf-8").write(t)
print("已產生", out)
