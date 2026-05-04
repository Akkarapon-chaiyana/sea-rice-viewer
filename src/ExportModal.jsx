import { useState, useCallback, useMemo, useEffect } from 'react';

// ── Layer / scale options ─────────────────────────────────────────────────────
const LAYER_OPTIONS = [
  { id: 'Mean',   label: '5-Fold Mean Probability', suffix: 'SEA_Avg',  extra: '' },
  { id: 'Std',    label: 'Standard Deviation',       suffix: 'SEA_Std',  extra: '' },
  { id: 'Binary', label: 'Binary (prob ≥ 50%)',       suffix: 'SEA_Avg',  outSuffix: 'SEA_Binary', extra: 'binary', clearNodata: true },
  { id: 'Pseudo', label: 'Pseudo-Labeling',           suffix: 'SEA_Pseu', extra: '',                                clearNodata: true },
];

const SCALES = [10, 30, 100, 250, 1000];

// Output filename prefix: binary uses SEA_Binary instead of SEA_Avg
const outSuf = l => l.outSuffix ?? l.suffix;

// ── Script helpers ────────────────────────────────────────────────────────────
function scriptHeader(mode, country, year, scale, projectId) {
  const proj = projectId || 'your-gcp-project-id';
  return (
    '#!/usr/bin/env python3\n' +
    '"""\n' +
    'SEA Rice Viewer — Export Script\n' +
    `Mode    : ${mode}\n` +
    `Country : ${country}\n` +
    `Year    : ${year}\n` +
    `Scale   : ${scale} m\n` +
    '"""\n' +
    'import ee\n\n' +
    '# ── GCP project ID — set to the project you signed in with ───────────────\n' +
    `GCP_PROJECT  = '${proj}'\n` +
    "ASSET_PREFIX = 'projects/tony-1122/assets/NIE/rice'\n\n" +
    'ee.Authenticate()\n' +
    'ee.Initialize(project=GCP_PROJECT)\n\n'
  );
}

function layerImg(l, slug) {
  // Timor-Leste binary layer is a pre-computed asset (SEA_binary_timor_YEAR),
  // not derived from SEA_Avg — load it directly, no .gte(50) needed.
  if (l.extra === 'binary' && slug === 'timor') {
    return `asset = f'{ASSET_PREFIX}/SEA_binary_${slug}_{YEAR}'\n` +
           `img   = ee.Image(asset)`;
  }
  const assetLine = `asset = f'{ASSET_PREFIX}/${l.suffix}_${slug}_{YEAR}'`;
  if (l.extra === 'binary') {
    // gte(50) gives 1 (rice) or 0 (not rice), masked where the asset has no data.
    // unmask(0, False) fills ALL masked pixels with 0 globally (sameFootprint=False),
    // so the output is fully unmasked: 1 = rice, 0 = non-rice or no-data coverage.
    return assetLine + '\n' +
      `img   = ee.Image(asset).gte(50).unmask(0, False)`;
  }
  return assetLine + '\n' + `img   = ee.Image(asset)`;
}

// Google Drive — whole country
function genDriveCountry({ country, slug, gaulName, year, scale, folder, selectedLayers, projectId }) {
  const hdr = scriptHeader('Google Drive — Whole Country', country, year, scale, projectId);
  return hdr +
    `COUNTRY       = '${slug}'\n` +
    `GAUL_NAME     = "${gaulName}"\n` +
    `YEAR          = ${year}\n` +
    `SCALE         = ${scale}\n` +
    `OUTPUT_FOLDER = '${folder}'\n\n` +
    `fc       = (ee.FeatureCollection('FAO/GAUL/2015/level0')\n` +
    `              .filter(ee.Filter.eq('ADM0_NAME', GAUL_NAME)))\n` +
    `geometry = fc.geometry()\n\n` +
    `print(f'Exporting {country} ({year}) at {scale} m ...')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      layerImg(l, slug) + `.clip(geometry)\n` +
      `desc  = f'${outSuf(l)}_{country}_{year}'\n` +
      `task  = ee.batch.Export.image.toDrive(\n` +
      `    image=img, description=desc, folder=OUTPUT_FOLDER,\n` +
      `    fileNamePrefix=desc, region=geometry,\n` +
      `    scale=SCALE, crs='EPSG:4326', maxPixels=1e13, fileFormat='GeoTIFF',\n` +
      `)\n` +
      `task.start()\n` +
      `print(f'  Started: {desc}  [{"{task.id}"}]')`
    ).join('\n') +
    `\n\nprint('\\nAll tasks submitted. Monitor at:')\n` +
    `print('  https://code.earthengine.google.com/tasks')\n`;
}

// Google Drive — grid tiles
function genDriveTiles({ country, slug, year, scale, folder, selectedLayers, activeTiles, projectId }) {
  const n   = activeTiles.length;
  const hdr = scriptHeader(`Google Drive — ${n} Tiles`, country, year, scale, projectId);
  const tilesList = activeTiles.map(t =>
    `    {'id': '${t.id}', 'bbox': [${t.bbox.join(', ')}]},`
  ).join('\n');
  return hdr +
    `COUNTRY       = '${slug}'\n` +
    `YEAR          = ${year}\n` +
    `SCALE         = ${scale}\n` +
    `OUTPUT_FOLDER = '${folder}'\n\n` +
    `TILES = [\n${tilesList}\n]\n\n` +
    `print(f'Submitting {len(TILES)} tile exports for ${country} ({year}) at ${scale} m ...')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      `for i, tile in enumerate(TILES):\n` +
      `    tid    = tile['id']\n` +
      `    w, s, e, n = tile['bbox']\n` +
      `    region = ee.Geometry.Rectangle([w, s, e, n])\n` +
      `    ` + layerImg(l, slug).replace(/\n/g, '\n    ') + `.clip(region)\n` +
      `    desc   = f'${outSuf(l)}_${country}_${year}_{tid}'\n` +
      `    task   = ee.batch.Export.image.toDrive(\n` +
      `        image=img, description=desc, folder=OUTPUT_FOLDER,\n` +
      `        fileNamePrefix=desc, region=region,\n` +
      `        scale=SCALE, crs='EPSG:4326', maxPixels=1e13, fileFormat='GeoTIFF',\n` +
      `    )\n` +
      `    task.start()\n` +
      `    print(f'  [{i+1}/{len(TILES)}] {desc}  [{"{task.id}"}]')`
    ).join('\n') +
    `\n\nprint('\\nAll tasks submitted. Monitor at:')\n` +
    `print('  https://code.earthengine.google.com/tasks')\n`;
}

// ── Shared helpers injected into every local-download script ─────────────────
// subdivide_tile splits a bbox into an n×n grid whose sub-tiles each stay
// below the GEE getDownloadURL limit (≈48 MB).  The maths:
//   pixels_x = deg_lon × 111320 × cos(lat) / scale_m
//   pixels_y = deg_lat × 110540            / scale_m
//   n        = ceil( sqrt(px_x × px_y / MAX_TILE_PX) )
//
// Tuning guide (single-band GeoTIFF, uncompressed):
//   data type │ safe MAX_TILE_PX  │ approx tile size
//   ──────────┼───────────────────┼─────────────────
//   uint8     │  40_000_000       │  ~40 MB
//   int16     │  20_000_000       │  ~40 MB
//   float32   │  10_000_000       │  ~40 MB
// Default 20 M is safe for int16 rice assets (~40 MB/tile, under GEE's 48 MB limit).
// Raise to 40M for uint8, lower to 10M for float32.
const PY_SUBDIVIDE =
  `import math, requests, zipfile, io, os, time\n\n` +
  `MAX_TILE_PX = 20_000_000  # int16 assets: 20M px ≈ 40 MB, safely under GEE's 48 MB limit\n` +
  `                           # uint8 → can raise to 40M; float32 → lower to 10M\n` +
  `MAX_RETRIES = 5            # retry on transient GEE 5xx / 429 errors\n\n` +
  `def subdivide_tile(west, south, east, north, scale_m):\n` +
  `    cos_lat = math.cos(math.radians((north + south) / 2))\n` +
  `    px_x    = abs(east  - west)  * 111_320 * cos_lat / scale_m\n` +
  `    px_y    = abs(north - south) * 110_540            / scale_m\n` +
  `    n       = max(1, math.ceil(math.sqrt(px_x * px_y / MAX_TILE_PX)))\n` +
  `    dlat    = (north - south) / n\n` +
  `    dlon    = (east  - west)  / n\n` +
  `    return [[round(west + c*dlon, 4), round(south + r*dlat, 4),\n` +
  `             round(west + (c+1)*dlon, 4), round(south + (r+1)*dlat, 4)]\n` +
  `            for r in range(n) for c in range(n)]\n\n` +
  `def download_image(img, fpath, region, clear_nodata=False):\n` +
  `    """Download one GeoTIFF to fpath with automatic retry on transient GEE errors.\n` +
  `    Returns True on success, False if the tile falls outside the image extent.\n` +
  `    """\n` +
  `    for attempt in range(1, MAX_RETRIES + 1):\n` +
  `        # ── 1. get signed download URL from GEE ───────────────────────────\n` +
  `        try:\n` +
  `            url = img.getDownloadURL({'scale': SCALE, 'crs': 'EPSG:4326',\n` +
  `                                      'region': region, 'format': 'GeoTIFF'})\n` +
  `        except Exception as e:\n` +
  `            msg = str(e).lower()\n` +
  `            if 'empty' in msg or ('geometry' in msg and 'clip' in msg):\n` +
  `                print('    skipped (tile outside image extent)')\n` +
  `                return False\n` +
  `            if attempt < MAX_RETRIES:\n` +
  `                wait = 2 ** attempt\n` +
  `                print(f'    GEE error (attempt {attempt}/{MAX_RETRIES}), retrying in {wait}s: {e}')\n` +
  `                time.sleep(wait)\n` +
  `                continue\n` +
  `            raise\n` +
  `        # ── 2. download the tile ──────────────────────────────────────────\n` +
  `        print(f'    {os.path.basename(fpath)} ...', end=' ', flush=True)\n` +
  `        try:\n` +
  `            resp = requests.get(url, stream=True)\n` +
  `            resp.raise_for_status()\n` +
  `        except requests.exceptions.HTTPError as e:\n` +
  `            if resp.status_code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:\n` +
  `                wait = 2 ** attempt\n` +
  `                print(f'HTTP {resp.status_code} (attempt {attempt}/{MAX_RETRIES}), retrying in {wait}s ...')\n` +
  `                time.sleep(wait)\n` +
  `                continue\n` +
  `            raise\n` +
  `        # ── 3. save to disk ───────────────────────────────────────────────\n` +
  `        data = resp.content\n` +
  `        if data[:2] == b'PK':                              # ZIP magic bytes\n` +
  `            with zipfile.ZipFile(io.BytesIO(data)) as z:\n` +
  `                nm = z.namelist()[0]\n` +
  `                z.extract(nm, OUTPUT_DIR)\n` +
  `                os.replace(os.path.join(OUTPUT_DIR, nm), fpath)\n` +
  `        elif data[:2] in (b'II', b'MM'):                  # TIFF little/big-endian\n` +
  `            with open(fpath, 'wb') as f: f.write(data)\n` +
  `        else:\n` +
  `            raise RuntimeError(f'Unexpected response for {os.path.basename(fpath)}: {data[:120]}')\n` +
  `        if clear_nodata:\n` +
  `            import rasterio\n` +
  `            with rasterio.open(fpath, 'r+') as ds: ds.nodata = None\n` +
  `        print('done')\n` +
  `        return True\n` +
  `    return False\n\n` +
  `def mosaic_subtiles(paths, out_path, clear_nodata=False):\n` +
  `    """Merge sub-tile GeoTIFFs into one file, then delete the parts."""\n` +
  `    if len(paths) == 1:\n` +
  `        os.replace(paths[0], out_path)\n` +
  `        if clear_nodata:\n` +
  `            import rasterio\n` +
  `            with rasterio.open(out_path, 'r+') as ds: ds.nodata = None\n` +
  `        return\n` +
  `    try:\n` +
  `        import rasterio\n` +
  `        from rasterio.merge import merge\n` +
  `        srcs    = [rasterio.open(p) for p in paths]\n` +
  `        mosaic, transform = merge(srcs)\n` +
  `        profile = srcs[0].profile.copy()\n` +
  `        profile.update({'width': mosaic.shape[2], 'height': mosaic.shape[1],\n` +
  `                        'transform': transform})\n` +
  `        if clear_nodata: profile['nodata'] = None\n` +
  `        for src in srcs: src.close()\n` +
  `        with rasterio.open(out_path, 'w', **profile) as dst: dst.write(mosaic)\n` +
  `        for p in paths: os.remove(p)\n` +
  `        print(f'    → mosaicked {len(paths)} sub-tiles → {os.path.basename(out_path)}')\n` +
  `    except ImportError:\n` +
  `        print('    [warn] rasterio not found; sub-tiles kept separately (pip install rasterio)')\n\n`;

// Local download — whole country (auto-tiled)
function genLocalCountry({ country, slug, gaulName, year, scale, selectedLayers, outputDir, projectId }) {
  const dir = outputDir || './sea_rice_output';
  const hdr = scriptHeader('Local Download — Whole Country', country, year, scale, projectId);
  return hdr +
    PY_SUBDIVIDE +
    `COUNTRY    = '${slug}'\n` +
    `GAUL_NAME  = "${gaulName}"\n` +
    `YEAR       = ${year}\n` +
    `SCALE      = ${scale}\n` +
    `OUTPUT_DIR = '${dir}'\n\n` +
    `os.makedirs(OUTPUT_DIR, exist_ok=True)\n\n` +
    `fc       = (ee.FeatureCollection('FAO/GAUL/2015/level0')\n` +
    `              .filter(ee.Filter.eq('ADM0_NAME', GAUL_NAME)))\n` +
    `geometry = fc.geometry()\n\n` +
    `# Derive country bbox → subdivide into download-safe tiles\n` +
    `ring   = fc.geometry().bounds().coordinates().getInfo()[0]\n` +
    `west   = min(c[0] for c in ring)\n` +
    `south  = min(c[1] for c in ring)\n` +
    `east   = max(c[0] for c in ring)\n` +
    `north  = max(c[1] for c in ring)\n` +
    `TILES  = subdivide_tile(west, south, east, north, SCALE)\n` +
    `print(f'${country} (${year}) at ${scale} m — {len(TILES)} download tile(s)')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      `for i, (tw, ts, te, tn) in enumerate(TILES):\n` +
      `    sub_geom = ee.Geometry.Rectangle([tw, ts, te, tn]).intersection(geometry)\n` +
      `    suf      = f'_t{i:03d}' if len(TILES) > 1 else ''\n` +
      `    fpath    = os.path.join(OUTPUT_DIR, f'${outSuf(l)}_${country}_${year}{suf}.tif')\n` +
      `    print(f'  [{i+1}/{len(TILES)}] {tw},{ts} → {te},{tn}')\n` +
      `    ` + layerImg(l, slug).replace(/\n/g, '\n    ') + `.clip(sub_geom)\n` +
      `    download_image(img, fpath, sub_geom${l.clearNodata ? ', clear_nodata=True' : ''})`
    ).join('\n') +
    `\n\nprint(f'\\nDone. Files saved to: {OUTPUT_DIR}/')\n`;
}

// Local download — grid tiles (auto-subdivided per tile, mosaicked after)
function genLocalTiles({ country, slug, year, scale, selectedLayers, outputDir, activeTiles, projectId }) {
  const n   = activeTiles.length;
  const dir = outputDir || './sea_rice_output';
  const hdr = scriptHeader(`Local Download — ${n} Tiles`, country, year, scale, projectId);
  const tilesList = activeTiles.map(t =>
    `    {'id': '${t.id}', 'bbox': [${t.bbox.join(', ')}]},`
  ).join('\n');
  return hdr +
    PY_SUBDIVIDE +
    `COUNTRY    = '${slug}'\n` +
    `YEAR       = ${year}\n` +
    `SCALE      = ${scale}\n` +
    `OUTPUT_DIR = '${dir}'\n\n` +
    `os.makedirs(OUTPUT_DIR, exist_ok=True)\n\n` +
    `TILES = [\n${tilesList}\n]\n\n` +
    `print(f'${country} (${year}) at ${scale} m — ${n} tile(s) selected')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      `for i, tile in enumerate(TILES):\n` +
      `    tid  = tile['id']\n` +
      `    w, s, e, n = tile['bbox']\n` +
      `    subs = subdivide_tile(w, s, e, n, SCALE)\n` +
      `    note = f' → {len(subs)} sub-tile(s)' if len(subs) > 1 else ''\n` +
      `    print(f'  Tile [{i+1}/{len(TILES)}] {tid}{note}')\n` +
      `    ` + layerImg(l, slug).replace(/\n/g, '\n    ') + `\n` +
      `    sub_paths = []\n` +
      `    for j, (sw, ss, se, sn) in enumerate(subs):\n` +
      `        region = ee.Geometry.Rectangle([sw, ss, se, sn])\n` +
      `        suf    = f'_s{j:02d}' if len(subs) > 1 else ''\n` +
      `        fpath  = os.path.join(OUTPUT_DIR, f'${outSuf(l)}_${country}_${year}_{tid}{suf}.tif')\n` +
      `        download_image(img.clip(region), fpath, region${l.clearNodata ? ', clear_nodata=True' : ''})\n` +
      `        sub_paths.append(fpath)\n` +
      `    out_path = os.path.join(OUTPUT_DIR, f'${outSuf(l)}_${country}_${year}_{tid}.tif')\n` +
      `    mosaic_subtiles(sub_paths, out_path${l.clearNodata ? ', clear_nodata=True' : ''})`
    ).join('\n') +
    `\n\nprint(f'\\nDone. Files saved to: {OUTPUT_DIR}/')\n`;
}

// Merge tiles — combine downloaded tile GeoTIFFs into one file per layer (GDAL)
// Uses BuildVRT + Translate: no full in-memory load, single-pass, LZW-compressed output.
function genMergeScript({ country, year, selectedLayers, outputDir, exportTarget }) {
  const dir = outputDir || './sea_rice_output';
  // country-mode tiles are named _t000, _t001 …; grid-tile-mode tiles use the tile ID
  const patternSuffix = exportTarget === 'country' ? '_t*.tif' : '_*.tif';
  return (
    '#!/usr/bin/env python3\n' +
    '"""\n' +
    'SEA Rice Viewer — Merge Script (GDAL)\n' +
    'Merges downloaded tile GeoTIFFs into one file per layer.\n' +
    `Country : ${country}\n` +
    `Year    : ${year}\n` +
    '\n' +
    'Requires GDAL Python bindings:\n' +
    '  conda install -c conda-forge gdal   # recommended\n' +
    '  pip install gdal                    # alternative\n' +
    '"""\n' +
    'import os, glob\n' +
    'from osgeo import gdal\n\n' +
    'gdal.UseExceptions()\n\n' +
    `OUTPUT_DIR = '${dir}'\n\n` +
    `print('Merging tiles for ${country} (${year}) ...')\n` +
    selectedLayers.map(l => {
      const suf = outSuf(l);
      return (
        `\n# ── ${l.label}\n` +
        `pattern  = os.path.join(OUTPUT_DIR, '${suf}_${country}_${year}${patternSuffix}')\n` +
        `files    = sorted(glob.glob(pattern))\n` +
        `if not files:\n` +
        `    print('  [${l.label}] No tiles found matching:', pattern)\n` +
        `else:\n` +
        `    print(f'  [${l.label}] Merging {len(files)} tile(s) ...')\n` +
        `    out_path = os.path.join(OUTPUT_DIR, '${suf}_${country}_${year}_merged.tif')\n` +
        `    vrt      = gdal.BuildVRT('', files)\n` +
        `    gdal.Translate(out_path, vrt, format='GTiff',\n` +
        `                   creationOptions=['COMPRESS=LZW', 'TILED=YES', 'BIGTIFF=IF_SAFER'])\n` +
        `    vrt = None  # flush & close\n` +
        (l.clearNodata
          ? `    # Remove auto-added nodata tag so 0-valued pixels are visible in GIS\n` +
            `    ds = gdal.Open(out_path, gdal.GA_Update)\n` +
            `    for i in range(1, ds.RasterCount + 1):\n` +
            `        ds.GetRasterBand(i).DeleteNoDataValue()\n` +
            `    ds = None\n`
          : '') +
        `    print('    ->', os.path.basename(out_path))\n`
      );
    }).join('') +
    `\nprint('\\nAll done. Merged files saved to:', OUTPUT_DIR)\n`
  );
}

// ── requirements_download.txt content (mirrored from repo root) ──────────────
const REQUIREMENTS_TXT =
`# Requirements for SEA Rice Viewer — Local Download scripts
# Install with:  pip install -r requirements_download.txt

earthengine-api>=0.1.370   # Google Earth Engine Python API
requests>=2.28.0            # HTTP download of GeoTIFF tiles
rasterio>=1.3.0             # Sub-tile mosaicking and nodata handling
`;

// ── Component ─────────────────────────────────────────────────────────────────
export default function ExportModal({
  country, slug, gaulName, year, projectId,
  selectedTiles,
  onSelectAllTiles, onSelectNoTiles,
  onClose,
}) {
  const [selected,     setSelected]     = useState({ Mean: false, Std: false, Binary: false, Pseudo: false });
  // Gate values always start null so the wizard runs sequentially every open.
  // Text-only fields (folder, outputDir) are remembered via localStorage.
  const [scale,        setScale]        = useState(null);
  const [exportTarget, setExportTarget] = useState(null); // 'country' | 'tiles'
  const [exportDest,   setExportDest]   = useState(null); // 'drive' | 'local'
  const [folder,       setFolder]       = useState(() => localStorage.getItem('sea_rice_folder')    || 'sea_rice_export');
  const [outputDir,    setOutputDir]    = useState(() => localStorage.getItem('sea_rice_outputDir') || './sea_rice_output');
  const [copied,       setCopied]       = useState(false);
  const [showScript,   setShowScript]   = useState(false);

  // Persist text fields so the user doesn't have to retype folder paths
  useEffect(() => { localStorage.setItem('sea_rice_folder',    folder);    }, [folder]);
  useEffect(() => { localStorage.setItem('sea_rice_outputDir', outputDir); }, [outputDir]);

  const handleExportTarget = useCallback((val) => setExportTarget(val), []);
  const handleClose        = useCallback(() => onClose(), [onClose]);

  const selectedLayers = LAYER_OPTIONS.filter(l => selected[l.id]);
  // selectedTiles is a Map<id, {id, bbox}> — convert to array for script generation
  const activeTiles    = [...(selectedTiles?.values() || [])];
  const totalTiles     = selectedTiles?.size ?? 0;

  const script = useMemo(() => {
    if (!scale || !exportTarget || !exportDest || selectedLayers.length === 0) return null;
    const args = { country, slug, gaulName, year, scale, folder, outputDir, selectedLayers, activeTiles, projectId };
    if (exportTarget === 'country') {
      return exportDest === 'drive' ? genDriveCountry(args) : genLocalCountry(args);
    } else {
      return exportDest === 'drive' ? genDriveTiles(args)   : genLocalTiles(args);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, slug, gaulName, year, scale, folder, outputDir, exportTarget, exportDest, projectId,
      JSON.stringify(selectedLayers.map(l => l.id)),
      activeTiles.length, JSON.stringify(activeTiles.map(t => t.id))]);

  const mergeScript = useMemo(() => {
    if (exportDest !== 'local') return null;
    return genMergeScript({ country, year, selectedLayers, outputDir, exportTarget });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, year, outputDir, exportTarget, exportDest,
      JSON.stringify(selectedLayers.map(l => l.id))]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(script).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [script]);

  const handleDownload = useCallback(() => {
    const triggerDownload = (content, filename) => {
      const blob = new Blob([content], { type: 'text/x-python' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    };
    triggerDownload(script, `rice_download_${slug}_${year}.py`);
    if (mergeScript) {
      // slight delay so browsers don't block the second download
      setTimeout(() => triggerDownload(mergeScript, `rice_download_merge_${slug}_${year}.py`), 300);
    }
  }, [script, mergeScript, slug, year]);

  const handleDownloadRequirements = useCallback(() => {
    const blob = new Blob([REQUIREMENTS_TXT], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'requirements_download.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>

        {/* Title bar */}
        <div className="modal-titlebar">
          <div className="modal-traffic">
            <span className="modal-dot red"   onClick={handleClose} />
            <span className="modal-dot yellow" />
            <span className="modal-dot green"  />
          </div>
          <span className="modal-title">Export — {country} {year}</span>
        </div>

        <div className="modal-body">

          {/* Layers */}
          <div className="modal-section">
            <div className="modal-label">Layers to export</div>
            <div className="modal-grid2">
              {LAYER_OPTIONS.map(l => (
                <label key={l.id} className="checkbox-row">
                  <input type="checkbox" checked={!!selected[l.id]}
                    onChange={e => setSelected(s => ({ ...s, [l.id]: e.target.checked }))} />
                  <span className="checkbox-label">{l.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Scale */}
          <div className={`modal-section${selectedLayers.length === 0 ? ' modal-locked' : ''}`}>
            <div className="modal-label">Resolution (m/px)</div>
            <div className="modal-scale-row">
              {SCALES.map(s => (
                <button key={s}
                  className={`scale-btn ${scale === s ? 'active' : ''}`}
                  onClick={() => setScale(s)}>
                  {s} m
                </button>
              ))}
            </div>
          </div>

          {/* Export area */}
          <div className={`modal-section${selectedLayers.length === 0 || !scale ? ' modal-locked' : ''}`}>
            <div className="modal-label">Export area</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[['country', 'Whole Country'], ['tiles', 'Grid Tiles']].map(([val, lbl]) => (
                <button key={val}
                  className={`scale-btn ${exportTarget === val ? 'active' : ''}`}
                  onClick={() => handleExportTarget(val)}>
                  {lbl}
                </button>
              ))}
            </div>

            {exportTarget === 'tiles' && (
              <div style={{ background: '#0d0d1f', border: '1px solid #2a2a4a', borderRadius: 6, padding: '10px 12px' }}>

                {/* Tile count + All/None */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span>
                    <span style={{ color: '#ff8c00', fontWeight: 700, fontSize: 15 }}>{activeTiles.length}</span>
                    <span style={{ color: '#666688', fontSize: 11 }}> tiles selected</span>
                  </span>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button className="scale-btn" style={{ padding: '2px 10px', fontSize: 10 }}
                      onClick={onSelectAllTiles}>All</button>
                    <button className="scale-btn" style={{ padding: '2px 10px', fontSize: 10 }}
                      onClick={onSelectNoTiles}>None</button>
                  </div>
                </div>

                {/* Guidance */}
                {activeTiles.length === 0 ? (
                  <div style={{ fontSize: 10, color: '#ff8c00', lineHeight: 1.5, padding: '6px 8px',
                    background: '#1a0e00', borderRadius: 4, border: '1px solid #553300' }}>
                    ← Close this panel and use <strong>🗺 Select tiles on map</strong> in the
                    sidebar, then reopen Export.
                  </div>
                ) : (
                  <div style={{ fontSize: 10, color: '#888899', lineHeight: 1.5 }}>
                    Orange tiles on map = selected. Use the sidebar to add/remove tiles.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Export destination */}
          <div className={`modal-section${selectedLayers.length === 0 || !scale || !exportTarget ? ' modal-locked' : ''}`}>
            <div className="modal-label">Export destination</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[['drive', '☁ Google Drive'], ['local', '💾 Local Download']].map(([val, lbl]) => (
                <button key={val}
                  className={`scale-btn ${exportDest === val ? 'active' : ''}`}
                  onClick={() => setExportDest(val)}>
                  {lbl}
                </button>
              ))}
            </div>
            {exportDest === 'drive' && (
              <input className="input" value={folder}
                onChange={e => setFolder(e.target.value)}
                placeholder="sea_rice_export" />
            )}
            {exportDest === 'local' && (
              <>
                <input className="input" value={outputDir}
                  onChange={e => setOutputDir(e.target.value)}
                  placeholder="./sea_rice_output" />
                <div style={{ fontSize: 10, color: '#7b8cde', marginTop: 4, lineHeight: 1.5 }}>
                  Uses <code style={{ background: '#1a1a32', padding: '1px 4px', borderRadius: 3 }}>getDownloadURL()</code>
                  — direct download to local disk. Suitable for tiles up to ~100 MB. For large areas use Drive.
                </div>

                {/* Installation requirements block */}
                <div style={{
                  marginTop: 10, padding: '10px 12px',
                  background: '#0d0d1f', border: '1px solid #2a2a4a', borderRadius: 6,
                }}>
                  <div style={{ fontSize: 11, color: '#ff8c00', fontWeight: 700, marginBottom: 6 }}>
                    📦 Required libraries
                  </div>
                  <code style={{
                    display: 'block', fontSize: 10, color: '#c8d0ff',
                    background: '#13132a', padding: '6px 10px', borderRadius: 4,
                    marginBottom: 8, userSelect: 'all',
                  }}>
                    pip install earthengine-api requests rasterio
                  </code>
                  <div style={{ fontSize: 10, color: '#666688', lineHeight: 1.6 }}>
                    <span style={{ color: '#7b8cde' }}>earthengine-api</span> — authenticate &amp; query GEE&emsp;
                    <span style={{ color: '#7b8cde' }}>requests</span> — stream tiles&emsp;
                    <span style={{ color: '#7b8cde' }}>rasterio</span> — mosaic &amp; nodata fix
                  </div>
                  <button
                    className="btn btn-copy"
                    style={{ marginTop: 8, fontSize: 10, padding: '4px 10px' }}
                    onClick={handleDownloadRequirements}
                  >
                    ↓ requirements_download.txt
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Script preview */}
          <div className={`modal-section${selectedLayers.length === 0 || !scale || !exportTarget || !exportDest ? ' modal-locked' : ''}`}>
            <div className="modal-label" style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => setShowScript(v => !v)}>
              <span style={{ fontSize: 10, color: '#7b8cde' }}>{showScript ? '▾' : '▸'}</span>
              Generated Python script
            </div>
            {showScript && (script
              ? <pre className="code-block">{script}</pre>
              : <div style={{ color: '#666688', fontSize: 12, padding: '12px 0' }}>
                  Select at least one layer, a resolution, an export area, and a destination to generate the script.
                </div>
            )}
          </div>

          {/* Citation */}
          <div className="modal-section">
            <div className="modal-label">Citation</div>
            <div style={{ fontSize: 11, color: '#9aa0c8', lineHeight: 1.7, background: '#13132a', borderRadius: 6, padding: '10px 14px' }}>
              Chaiyana, A., &amp; Wang, J. (2026).<br />
              <em>High-Resolution Rice Area Inventory for Southeast Asia Using a Deep-Learning Ensemble Framework with Uncertainty-Guided Self-Training.</em><br />
              National Institute of Education (NIE), Nanyang Technological University (NTU), Singapore.
            </div>
          </div>

          {/* Contact */}
          <div className="modal-section">
            <div className="modal-label">Contact</div>
            <div style={{ fontSize: 11, color: '#9aa0c8', lineHeight: 2, background: '#13132a', borderRadius: 6, padding: '10px 14px' }}>
              <div>Akkarapon Chaiyana &nbsp;<a href="mailto:akkarapon.c@nie.edu.sg" style={{ color: '#7b8cde' }}>akkarapon.c@nie.edu.sg</a></div>
              <div>Wang Jingyu &nbsp;<a href="mailto:jingyu.wang@nie.edu.sg" style={{ color: '#7b8cde' }}>jingyu.wang@nie.edu.sg</a></div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className={`modal-footer${!script ? ' modal-locked' : ''}`}>
          <button className="btn btn-copy" onClick={handleCopy}>
            {copied ? '✓ Copied!' : 'Copy Script'}
          </button>
          <button className="btn btn-download-py" onClick={handleDownload}>
            {mergeScript ? '↓ Download 2 scripts' : '↓ Download .py'}
          </button>
        </div>

      </div>
    </div>
  );
}
