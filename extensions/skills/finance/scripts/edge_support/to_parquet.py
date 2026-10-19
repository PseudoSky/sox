"""Convert bar rows (JSON) to the edge pipeline's OHLCV parquet. Runs as a subprocess so the
finance core itself never imports pandas: `python -I to_parquet.py rows.json out.parquet`."""
import json
import sys

try:
    import pandas as pd
    import pyarrow  # noqa: F401  (parquet engine)
except ImportError as exc:
    sys.stderr.write(f"missing {exc.name}: python3 -m pip install pandas pyarrow\n")
    sys.exit(3)

rows = json.loads(open(sys.argv[1], encoding="utf-8").read())
frame = pd.DataFrame(rows)
frame["timestamp"] = pd.to_datetime(frame["timestamp"])
frame.to_parquet(sys.argv[2], index=False)
print(json.dumps({"rows": len(frame), "first": str(frame["timestamp"].min().date()),
                  "last": str(frame["timestamp"].max().date())}))
