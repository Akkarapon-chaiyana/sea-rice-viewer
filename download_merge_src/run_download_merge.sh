#!/bin/bash
set -e

YEAR="2021"
DOWNLOADS="/Users/achaiyan/Downloads"
DEST_DIR="${DOWNLOADS}/binary_maps"

for COUNTRY in philippines malaysia indonesia; do
    echo "========================================="
    echo " ${COUNTRY} ${YEAR}"
    echo "========================================="

    OUTPUT_DIR="${DOWNLOADS}/sea_rice_output"

    # ── 1. Download tiles ─────────────────────────────────────────────────────
    echo "[${COUNTRY}] Downloading ..."
    python "${DOWNLOADS}/sea_rice_export_${COUNTRY}_${YEAR}.py"
    echo "[${COUNTRY}] Download complete."

    # ── 2. Merge tiles ────────────────────────────────────────────────────────
    echo "[${COUNTRY}] Merging ..."
    python "${DOWNLOADS}/sea_rice_merge_${COUNTRY}_${YEAR}.py"
    echo "[${COUNTRY}] Merge complete."

    # ── 3. Copy merged TIFFs to destination ──────────────────────────────────
    mkdir -p "${DEST_DIR}"
    cp "${OUTPUT_DIR}"/*_"${YEAR}"_merged.tif "${DEST_DIR}/"
    echo "[${COUNTRY}] Copied merged files to ${DEST_DIR}/"

    # ── 4. Clean up (only after successful copy) ──────────────────────────────
    rm -rf "${OUTPUT_DIR}"
    echo "[${COUNTRY}] Cleaned up. Done."

done

echo ""
echo "All countries complete. Files in: ${DEST_DIR}/"

