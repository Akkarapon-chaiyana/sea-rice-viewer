#!/usr/bin/env python3
"""
SEA Rice Viewer — Binary Merge Script (GDAL)
Scans INPUT_DIR for all .tif files and merges them with priority-1 logic
(logical OR). Overlapping pixels: value 1 takes priority over 0.

Usage:
  python sea_rice_merge.py                   # uses INPUT_DIR / OUTPUT_DIR below
  python sea_rice_merge.py <input_dir>       # custom input, output same dir
  python sea_rice_merge.py <input_dir> <output_dir>

Requires GDAL Python bindings:
  conda install -c conda-forge gdal
"""
import os, sys, glob, tempfile
import numpy as np
from osgeo import gdal

gdal.UseExceptions()

# ── Paths (override via CLI args) ──────────────────────────────────────────────
INPUT_DIR  = sys.argv[1] if len(sys.argv) > 1 else '/Users/achaiyan/Downloads/rice_data'
OUTPUT_DIR = sys.argv[2] if len(sys.argv) > 2 else INPUT_DIR
OUTPUT_NAME = 'SEA_Binary_merged.tif'

PX    = 0.000269494585236  # shared pixel size (~30 m at equator)
BLOCK = 1024               # rows processed per iteration


# ── Helpers ────────────────────────────────────────────────────────────────────
def get_extent(ds):
    gt = ds.GetGeoTransform()
    xmin = gt[0]
    ymax = gt[3]
    xmax = xmin + ds.RasterXSize * gt[1]
    ymin = ymax + ds.RasterYSize * gt[5]   # gt[5] is negative
    return xmin, ymin, xmax, ymax


def union_extent(extents):
    return (
        min(e[0] for e in extents),
        min(e[1] for e in extents),
        max(e[2] for e in extents),
        max(e[3] for e in extents),
    )


def warp_to_extent(src_path, extent, px, tmp_dir):
    """Warp a single file to the target extent, filling outside area with 0."""
    xmin, ymin, xmax, ymax = extent
    out_path = os.path.join(
        tmp_dir, os.path.basename(src_path).replace('.tif', '_union.tif')
    )
    gdal.Warp(
        out_path, src_path,
        outputBounds=(xmin, ymin, xmax, ymax),
        xRes=px, yRes=px,
        srcNodata=None, dstNodata=0,
        outputType=gdal.GDT_Byte,
        creationOptions=['COMPRESS=LZW', 'TILED=YES'],
    )
    return out_path


# ── Discover input files ───────────────────────────────────────────────────────
files = sorted(glob.glob(os.path.join(INPUT_DIR, '*.tif')))
if not files:
    print(f'No .tif files found in: {INPUT_DIR}')
    sys.exit(1)

out_path = os.path.join(OUTPUT_DIR, OUTPUT_NAME)
os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f'Found {len(files)} file(s) in {INPUT_DIR}:')
for f in files:
    print(f'  {os.path.basename(f)}')

# ── Compute union extent ───────────────────────────────────────────────────────
datasets = [gdal.Open(f) for f in files]
ux = union_extent([get_extent(ds) for ds in datasets])
for ds in datasets:
    ds = None
print(f'\nUnion extent: {ux[0]:.6f} {ux[1]:.6f} {ux[2]:.6f} {ux[3]:.6f}')

# ── Merge ──────────────────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    # Step 1 — warp every input to the union extent
    print('Warping inputs to union extent ...')
    warped = [warp_to_extent(f, ux, PX, tmp) for f in files]

    # Step 2 — open warped files
    ds_list = [gdal.Open(w) for w in warped]
    ref  = ds_list[0]
    cols = ref.RasterXSize
    rows = ref.RasterYSize
    gt   = ref.GetGeoTransform()
    proj = ref.GetProjection()
    print(f'Output size: {cols} x {rows} px')

    # Step 3 — create output GeoTIFF
    driver = gdal.GetDriverByName('GTiff')
    out_ds = driver.Create(
        out_path, cols, rows, 1, gdal.GDT_Byte,
        options=['COMPRESS=LZW', 'TILED=YES', 'BIGTIFF=IF_SAFER'],
    )
    out_ds.SetGeoTransform(gt)
    out_ds.SetProjection(proj)
    out_band = out_ds.GetRasterBand(1)
    out_band.SetNoDataValue(255)

    # Step 4 — merge block-by-block with logical OR (numpy.maximum)
    print('Merging with priority-1 logic ...')
    for y in range(0, rows, BLOCK):
        y_size = min(BLOCK, rows - y)
        result = None
        for ds in ds_list:
            arr = ds.GetRasterBand(1).ReadAsArray(0, y, cols, y_size).astype(np.uint8)
            result = arr if result is None else np.maximum(result, arr)
        out_band.WriteArray(result, 0, y)

    out_band.FlushCache()
    out_ds = None
    for ds in ds_list:
        ds = None

print(f'\nDone. Output saved to: {out_path}')
