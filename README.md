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

## Prerequisites (new users)

Before using the viewer or running any export script, complete the three steps below.

### Step A — Install Python

We recommend **Miniconda** (lightweight) or **Anaconda** (full scientific stack).

| Installer | Download |
|---|---|
| Miniconda (recommended) | <https://docs.conda.io/en/latest/miniconda.html> |
| Anaconda | <https://www.anaconda.com/download> |
| Python only (advanced) | <https://www.python.org/downloads> |

After installing, open **Anaconda Prompt** (Windows) or **Terminal** (macOS/Linux) and verify:

```bash
python --version   # should print Python 3.9 or higher
```

Create a dedicated environment (recommended):

```bash
conda create -n sea_rice python=3.11
conda activate sea_rice
```

Then install all required libraries at once:

```bash
conda install -c conda-forge earthengine-api requests numpy rasterio gdal
```

---

### Step B — Create a Google Earth Engine account

1. Go to <https://earthengine.google.com> and click **Sign Up**.
2. Sign in with a Google account and fill in the registration form.
3. Select **Use with a Cloud Project** when asked.
4. Wait for approval (usually instant for academic accounts, up to 24 h otherwise).

---

### Step C — Create a Google Cloud Project and enable the Earth Engine API

GEE requires a linked **Google Cloud Platform (GCP) project** for API access.

1. Go to <https://console.cloud.google.com> and sign in.
2. Click **Select a project → New Project**, give it a name (e.g. `sea-rice-viewer`), and click **Create**.
3. Note the **Project ID** shown under the project name — you will need this in the app.
4. In the search bar type **Earth Engine API**, open it, and click **Enable**.
5. *(Optional)* If prompted, enable billing — a free-tier account is sufficient for typical use.

Once the project is ready, paste the **Project ID** into the app's Authentication panel and sign in.

---

## Getting started

1. Enter your **GCP Project ID** in the Authentication panel.
2. Click **Sign In with Google** — authorise with the account that has GEE access.
3. Select a **Country** (including **All countries**) and **Year**.
4. Toggle **Map Layers** to visualise rice probability on the map (5-Fold Ensemble Probability and Binary are currently available).
5. Use the **Export** button to generate a ready-to-run Python download script.

---

## Exporting GeoTIFF images

The **Export GeoTIFF (Python)** panel generates a script through a sequential wizard:

| Step | Description |
|---|---|
| **1 — Layers to export** | Select one or more output layers (5-Fold Mean Probability, Binary) |
| **2 — Resolution** | Choose pixel size: 10 / 30 / 100 / 250 / 1000 m |
| **3 — Export area** | Whole country or custom grid tiles |
| **4 — Export destination** | Google Drive or Local Download |

Two export modes are available:

| Mode | How it works |
|---|---|
| **Google Drive** | Submits GEE batch tasks → files land in your Drive folder |
| **Local Download** | Streams tiles directly to your machine via `getDownloadURL()` |

---

## Local Download — setup guide

### 1. Python requirements

Install all required libraries (Python ≥ 3.9 recommended):

```bash
pip install -r requirements_download.txt
```

Or manually:

```bash
pip install earthengine-api requests numpy rasterio gdal
```

> **Note:** `rasterio` and `gdal` can be tricky to install on Windows/macOS via pip.
> The conda approach is strongly recommended:
> ```bash
> conda install -c conda-forge earthengine-api requests rasterio gdal numpy
> ```

| Library | Purpose |
|---|---|
| `earthengine-api` | Authenticate and query Google Earth Engine |
| `requests` | Stream GeoTIFF tiles from GEE download URLs |
| `numpy` | Array operations (rasterio dependency) |
| `rasterio` | Mosaic sub-tiles and strip nodata metadata |
| `gdal` | Merge downloaded tiles (merge script only) |

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

Use the same project you authenticated with (already pre-filled if entered in the app).

### 4. Run the script

```bash
python rice_download_thailand_2021.py
```

Progress is printed tile by tile.
Files are saved to the `OUTPUT_DIR` path set in the script (default: `./sea_rice_output/`).

### 5. Merge tiles (Local Download only)

When using Local Download, a second merge script is also downloaded:

```bash
python rice_download_merge_thailand_2021.py
```

This uses GDAL (`BuildVRT` + `Translate`) to combine all downloaded tiles into one GeoTIFF per layer with LZW compression.

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
python rice_download_thailand_2021.py
```

Tasks are submitted to GEE. Monitor progress at:
<https://code.earthengine.google.com/tasks>

Files appear in your Google Drive folder once each task completes.

---

## Output layers

| Layer | Filename prefix | Values | Notes |
|---|---|---|---|
| 5-Fold Mean Probability | `SEA_Avg_` | 0 – 100 | Rice probability (%) |
| Binary | `SEA_binary_` | 0 or 1 | 1 = rice (prob ≥ 50%), 0 = non-rice |

> **Note:** Standard Deviation (`SEA_Std_`) and Pseudo-Labeling (`SEA_Pseu_`) layers are temporarily disabled in the current release.

All outputs use **EPSG:4326** (WGS 84) and the resolution selected in the export panel (10 / 30 / 100 / 250 / 1000 m).

---

## Supported countries

| Country | Slug | Data available |
|---|---|---|
| Thailand | `thailand` | 2021 |
| Myanmar | `myanmar` | 2021 |
| Vietnam | `vietnam` | 2021 |
| Laos | `laos` | 2021 |
| Cambodia | `cambodia` | 2021 |
| Philippines | `philippines` | 2021 |
| Malaysia | `malaysia` | 2021 |
| Indonesia | `indonesia` | 2021 |
| Brunei | `brunei` | 2021 |
| Timor-Leste | `timor` | 2021 |
| Singapore | `singapore` | Not included |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `EEException: Permission denied` | Check GCP project ID and re-run `earthengine authenticate` |
| `RuntimeError: Unexpected response` | Tile may be too large — reduce resolution or switch to Grid Tiles mode |
| Binary / Pseudo shows only `1` (no `0`) | Regenerate the script from the app (old scripts lacked `clear_nodata`) |
| `rasterio not found` warning | `pip install rasterio` or `conda install -c conda-forge rasterio` |
| `gdal` install fails | Use conda: `conda install -c conda-forge gdal` |
| Script hangs on a tile | GEE may be slow — wait, or reduce tile resolution |
| Country shows "not included" error | That country has no analysis data (e.g. Singapore) |

---

## Citation

Chaiyana, A., & Wang, J. (2026). *High-Resolution Rice Area Inventory for Southeast Asia Using a Deep-Learning Ensemble Framework with Uncertainty-Guided Self-Training.* National Institute of Education (NIE), Nanyang Technological University (NTU), Singapore.

---

## Contact

- Akkarapon Chaiyana (email: akkarapon.c@nie.edu.sg)
- Wang Jingyu (email: jingyu.wang@nie.edu.sg)
