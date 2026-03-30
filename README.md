# SEA Rice Viewer

Interactive web viewer for Southeast Asia rice mapping results.
Browse, compare, and export GEE assets as GeoTIFF for any country and year.

---

## Running the viewer locally

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

---

## Exporting GeoTIFF images

The **Export** panel (click the export button on the map) generates a ready-to-run Python script.
Two export modes are available:

| Mode | How it works |
|---|---|
| **Google Drive** | Submits GEE batch tasks → files land in your Drive folder |
| **Local Download** | Streams tiles directly to your machine via `getDownloadURL()` |

---

## Local Download — setup guide

### 1. Python requirements

Install the three required libraries (Python ≥ 3.9 recommended):

```bash
pip install earthengine-api requests rasterio
```

Or using the provided file:

```bash
pip install -r requirements_download.txt
```

| Library | Purpose |
|---|---|
| `earthengine-api` | Authenticate and query Google Earth Engine |
| `requests` | Stream GeoTIFF tiles from GEE download URLs |
| `rasterio` | Mosaic sub-tiles and strip nodata metadata |

### 2. Authenticate with Google Earth Engine

Run once before using any export script:

```bash
earthengine authenticate
```

This opens a browser window — sign in with the Google account that has access to the GEE project.

### 3. Set your GCP Project ID

Open the generated `.py` file and set:

```python
GCP_PROJECT = 'your-gcp-project-id'
```

Use the same project you authenticated with.

### 4. Run the script

```bash
python sea_rice_export_thailand_2021.py
```

Progress is printed tile by tile.
Files are saved to the `OUTPUT_DIR` path set in the script (default: `./sea_rice_output/`).

---

## Google Drive — setup guide

### 1. Python requirements

```bash
pip install earthengine-api
```

### 2. Authenticate

```bash
earthengine authenticate
```

### 3. Run the script and monitor tasks

```bash
python sea_rice_export_thailand_2021.py
```

Tasks are submitted to GEE. Monitor progress at:
<https://code.earthengine.google.com/tasks>

Files appear in your Google Drive folder once each task completes.

---

## Output layers

| Layer | Filename prefix | Values | Notes |
|---|---|---|---|
| 5-Fold Mean Probability | `SEA_Avg_` | 0 – 100 | Rice probability (%) |
| Standard Deviation | `SEA_Std_` | 0 – 45 | Uncertainty across 5 folds |
| Binary | `SEA_Binary_` | 0 or 1 | 1 = rice (prob ≥ 50%), 0 = non-rice |
| Pseudo-Labeling | `SEA_Pseu_` | 0, 1, 2 | 0 = background, 1 = rice, 2 = pseudo-label |

All outputs use **EPSG:4326** (WGS 84) and the resolution selected in the export panel (10 / 30 / 100 / 250 / 1000 m).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `EEException: Permission denied` | Check GCP project ID and re-run `earthengine authenticate` |
| `RuntimeError: Unexpected response` | Tile may be too large — reduce resolution or switch to Grid Tiles mode |
| Binary / Pseudo shows only `1` (no `0`) | Regenerate the script from the app (old scripts lacked `clear_nodata`) |
| `rasterio not found` warning | `pip install rasterio` — sub-tiles are kept separately without it |
| Script hangs on a tile | GEE may be slow; wait or reduce tile resolution |
