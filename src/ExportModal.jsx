import { useState, useCallback, useMemo, useEffect } from 'react';

// ── Layer / scale options ─────────────────────────────────────────────────────
const LAYER_OPTIONS = [
  { id: 'Mean',   label: '5-Fold Mean Probability', suffix: 'SEA_Avg',  extra: '' },
  { id: 'Std',    label: 'Standard Deviation',       suffix: 'SEA_Std',  extra: '' },
  { id: 'Binary', label: 'Binary (prob ≥ 50%)',       suffix: 'SEA_Avg',  extra: 'binary' },
  { id: 'Pseudo', label: 'Pseudo-Labeling',           suffix: 'SEA_Pseu', extra: '' },
];

const SCALES = [10, 30, 100, 250, 1000];

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

function layerImg(l) {
  const mask = l.extra === 'binary' ? '.gte(50).selfMask()' : '';
  return (
    `asset = f'{ASSET_PREFIX}/${l.suffix}_' + COUNTRY.lower() + f'_{YEAR}'\n` +
    `img   = ee.Image(asset)${mask}`
  );
}

// Google Drive — whole country
function genDriveCountry({ country, gaulName, year, scale, folder, selectedLayers, projectId }) {
  const hdr = scriptHeader('Google Drive — Whole Country', country, year, scale, projectId);
  return hdr +
    `COUNTRY       = '${country}'\n` +
    `GAUL_NAME     = '${gaulName}'\n` +
    `YEAR          = ${year}\n` +
    `SCALE         = ${scale}\n` +
    `OUTPUT_FOLDER = '${folder}'\n\n` +
    `fc       = (ee.FeatureCollection('FAO/GAUL/2015/level0')\n` +
    `              .filter(ee.Filter.eq('ADM0_NAME', GAUL_NAME)))\n` +
    `geometry = fc.geometry()\n\n` +
    `print(f'Exporting {country} ({year}) at {scale} m ...')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      layerImg(l) + `.clip(geometry)\n` +
      `desc  = f'${l.suffix}_{country}_{year}'\n` +
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
function genDriveTiles({ country, year, scale, folder, selectedLayers, activeTiles, projectId }) {
  const n   = activeTiles.length;
  const hdr = scriptHeader(`Google Drive — ${n} Tiles`, country, year, scale, projectId);
  const tilesList = activeTiles.map(t =>
    `    [${t.bbox.join(', ')}],  # ${t.id}`
  ).join('\n');
  return hdr +
    `COUNTRY       = '${country}'\n` +
    `YEAR          = ${year}\n` +
    `SCALE         = ${scale}\n` +
    `OUTPUT_FOLDER = '${folder}'\n\n` +
    `TILES = [\n${tilesList}\n]\n\n` +
    `print(f'Submitting {len(TILES)} tile exports for ${country} ({year}) at ${scale} m ...')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      `for i, (w, s, e, n) in enumerate(TILES):\n` +
      `    region = ee.Geometry.Rectangle([w, s, e, n])\n` +
      `    ` + layerImg(l).replace(/\n/g, '\n    ') + `.clip(region)\n` +
      `    desc   = f'${l.suffix}_${country}_${year}_t{i:03d}'\n` +
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

// Local download — whole country
function genLocalCountry({ country, gaulName, year, scale, selectedLayers, outputDir, projectId }) {
  const dir = outputDir || './sea_rice_output';
  const hdr = scriptHeader('Local Download — Whole Country', country, year, scale, projectId);
  return hdr +
    `import requests, zipfile, io, os\n\n` +
    `COUNTRY    = '${country}'\n` +
    `GAUL_NAME  = '${gaulName}'\n` +
    `YEAR       = ${year}\n` +
    `SCALE      = ${scale}\n` +
    `OUTPUT_DIR = '${dir}'\n\n` +
    `os.makedirs(OUTPUT_DIR, exist_ok=True)\n\n` +
    `fc       = (ee.FeatureCollection('FAO/GAUL/2015/level0')\n` +
    `              .filter(ee.Filter.eq('ADM0_NAME', GAUL_NAME)))\n` +
    `geometry = fc.geometry()\n\n` +
    `def download_image(img, desc, region):\n` +
    `    url = img.getDownloadURL({'scale': SCALE, 'crs': 'EPSG:4326',\n` +
    `                              'region': region, 'format': 'GeoTIFF'})\n` +
    `    print(f'  Downloading {desc} ...', end=' ', flush=True)\n` +
    `    resp = requests.get(url, stream=True)\n` +
    `    resp.raise_for_status()\n` +
    `    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:\n` +
    `        z.extractall(OUTPUT_DIR)\n` +
    `    print('done')\n\n` +
    `print(f'Downloading ${country} (${year}) at ${scale} m ...')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      layerImg(l) + `.clip(geometry)\n` +
      `download_image(img, f'${l.suffix}_${country}_${year}', geometry)`
    ).join('\n') +
    `\n\nprint(f'\\nDone. Files saved to: {OUTPUT_DIR}/')\n`;
}

// Local download — grid tiles
function genLocalTiles({ country, year, scale, selectedLayers, outputDir, activeTiles, projectId }) {
  const n   = activeTiles.length;
  const dir = outputDir || './sea_rice_output';
  const hdr = scriptHeader(`Local Download — ${n} Tiles`, country, year, scale, projectId);
  const tilesList = activeTiles.map(t =>
    `    [${t.bbox.join(', ')}],  # ${t.id}`
  ).join('\n');
  return hdr +
    `import requests, zipfile, io, os\n\n` +
    `COUNTRY    = '${country}'\n` +
    `YEAR       = ${year}\n` +
    `SCALE      = ${scale}\n` +
    `OUTPUT_DIR = '${dir}'\n\n` +
    `os.makedirs(OUTPUT_DIR, exist_ok=True)\n\n` +
    `TILES = [\n${tilesList}\n]\n\n` +
    `def download_image(img, desc, region):\n` +
    `    url = img.getDownloadURL({'scale': SCALE, 'crs': 'EPSG:4326',\n` +
    `                              'region': region, 'format': 'GeoTIFF'})\n` +
    `    print(f'  Downloading {desc} ...', end=' ', flush=True)\n` +
    `    resp = requests.get(url, stream=True)\n` +
    `    resp.raise_for_status()\n` +
    `    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:\n` +
    `        z.extractall(OUTPUT_DIR)\n` +
    `    print('done')\n\n` +
    `print(f'Downloading {len(TILES)} tiles for ${country} (${year}) at ${scale} m ...')\n` +
    selectedLayers.map(l =>
      `\n# ── ${l.label}\n` +
      `for i, (w, s, e, n) in enumerate(TILES):\n` +
      `    region = ee.Geometry.Rectangle([w, s, e, n])\n` +
      `    print(f'  Tile [{i+1}/{len(TILES)}]: [{w},{s} → {e},{n}]')\n` +
      `    ` + layerImg(l).replace(/\n/g, '\n    ') + `.clip(region)\n` +
      `    download_image(img, f'${l.suffix}_${country}_${year}_t{i:03d}', region)`
    ).join('\n') +
    `\n\nprint(f'\\nDone. Files saved to: {OUTPUT_DIR}/')\n`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ExportModal({
  country, gaulName, year, projectId,
  selectedTiles, tileSelectActive,
  onTileSelectToggle, onSelectAllTiles, onSelectNoTiles,
  onClose,
}) {
  const [selected,     setSelected]     = useState({ Mean: true, Std: false, Binary: false, Pseudo: false });
  const [scale,        setScale]        = useState(30);
  const [exportTarget, setExportTarget] = useState('country'); // 'country' | 'tiles'
  const [exportDest,   setExportDest]   = useState('drive');   // 'drive' | 'local'
  const [folder,       setFolder]       = useState('sea_rice_export');
  const [outputDir,    setOutputDir]    = useState('./sea_rice_output');
  const [copied,       setCopied]       = useState(false);

  // Deactivate tile select when switching away from tiles mode
  const handleExportTarget = useCallback((val) => {
    setExportTarget(val);
    if (val !== 'tiles' && tileSelectActive) onTileSelectToggle(false);
  }, [tileSelectActive, onTileSelectToggle]);

  // Deactivate tile select + close
  const handleClose = useCallback(() => {
    if (tileSelectActive) onTileSelectToggle(false);
    onClose();
  }, [tileSelectActive, onTileSelectToggle, onClose]);

  const selectedLayers = LAYER_OPTIONS.filter(l => selected[l.id]);
  // selectedTiles is a Map<id, {id, bbox}> — convert to array for script generation
  const activeTiles    = [...(selectedTiles?.values() || [])];
  const totalTiles     = selectedTiles?.size ?? 0;

  const script = useMemo(() => {
    const args = { country, gaulName, year, scale, folder, outputDir, selectedLayers, activeTiles, projectId };
    if (exportTarget === 'country') {
      return exportDest === 'drive' ? genDriveCountry(args) : genLocalCountry(args);
    } else {
      return exportDest === 'drive' ? genDriveTiles(args)   : genLocalTiles(args);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, gaulName, year, scale, folder, outputDir, exportTarget, exportDest, projectId,
      JSON.stringify(selectedLayers.map(l => l.id)),
      activeTiles.length, JSON.stringify(activeTiles.map(t => t.id))]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(script).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [script]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([script], { type: 'text/x-python' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `sea_rice_export_${country.toLowerCase()}_${year}.py`;
    a.click();
    URL.revokeObjectURL(url);
  }, [script, country, year]);

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
          <div className="modal-section">
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
          <div className="modal-section">
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
                {/* Tile count row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: '#aaaacc' }}>
                    <span style={{ color: '#7b8cde', fontWeight: 600, fontSize: 14 }}>{activeTiles.length}</span>
                    <span style={{ color: '#666688' }}> tiles selected (SEA grid)</span>
                  </span>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button className="scale-btn" style={{ padding: '2px 10px', fontSize: 10 }}
                      onClick={onSelectAllTiles}>All</button>
                    <button className="scale-btn" style={{ padding: '2px 10px', fontSize: 10 }}
                      onClick={onSelectNoTiles}>None</button>
                  </div>
                </div>

                {/* Map select toggle */}
                <button
                  className={`btn ${tileSelectActive ? 'btn-sign-in signed-in' : 'btn-export'}`}
                  style={{ width: '100%', marginBottom: 6 }}
                  onClick={() => onTileSelectToggle(!tileSelectActive)}>
                  {tileSelectActive
                    ? '✓ Selecting on map — click to finish'
                    : '🗺 Click tiles on map to select / deselect'}
                </button>

                {tileSelectActive && (
                  <div style={{ fontSize: 10, color: '#7b8cde', lineHeight: 1.4 }}>
                    Blue tiles = selected for export. Click any tile to toggle. Enable the
                    50 km grid overlay to see tile boundaries clearly.
                  </div>
                )}

                {activeTiles.length === 0 && (
                  <div className="auth-status error" style={{ marginTop: 4 }}>
                    No tiles selected — click tiles on the map or use <strong>All</strong>.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Export destination */}
          <div className="modal-section">
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
              </>
            )}
          </div>

          {/* Script preview */}
          <div className="modal-section">
            <div className="modal-label">Generated Python script</div>
            <pre className="code-block">{script}</pre>
          </div>

        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-copy" onClick={handleCopy}>
            {copied ? '✓ Copied!' : 'Copy Script'}
          </button>
          <button className="btn btn-download-py" onClick={handleDownload}>
            ↓ Download .py
          </button>
        </div>

      </div>
    </div>
  );
}
