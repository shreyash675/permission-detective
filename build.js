#!/usr/bin/env node
/**
 * Permission Detective — build & packaging script
 * Usage: node build.js
 *
 * Zero required dependencies. If `esbuild` or `terser` are installed
 * (npm install --save-dev esbuild   OR   npm install --save-dev terser),
 * they're used for real minification. Otherwise this falls back to a
 * lightweight regex-based minifier (comment/whitespace stripping only —
 * no renaming or dead-code elimination).
 *
 * Steps: validate required files -> validate manifest.json -> build dist/
 * (minified copies) -> zip dist/ into permission-detective-v{version}.zip
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'overlay.js',
  'overlay.css',
  'grant-access.html',
  'grant-access.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

// ---------------------------------------------------------------------------
// Step 1: validate required files exist
// ---------------------------------------------------------------------------

function checkRequiredFiles() {
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('✖ Missing required file(s):');
    missing.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('✓ All required files present');
}

// ---------------------------------------------------------------------------
// Step 2: validate manifest.json, collecting non-fatal warnings
// ---------------------------------------------------------------------------

function isModuleAvailable(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function validateManifest(manifest) {
  const warnings = [];

  if (manifest.manifest_version !== 3) {
    warnings.push('manifest_version is not 3 (Manifest V3 is required for new Chrome Web Store submissions).');
  }

  if (!manifest.host_permissions || manifest.host_permissions.length === 0) {
    warnings.push('No host_permissions declared — API calls to Salesforce will fail without them.');
  } else if (manifest.host_permissions.includes('<all_urls>')) {
    warnings.push('host_permissions includes <all_urls> — scope this down to specific Salesforce domains to reduce review friction.');
  }

  if (!manifest.version || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    warnings.push(`version "${manifest.version}" is not a plain X.Y.Z semver string.`);
  }

  if (!manifest.icons || !manifest.icons['16'] || !manifest.icons['48'] || !manifest.icons['128']) {
    warnings.push('manifest.icons should declare 16, 48, and 128 px icons.');
  } else {
    ['16', '48', '128'].forEach((size) => {
      if (!fs.existsSync(path.join(ROOT, manifest.icons[size]))) {
        warnings.push(`Icon referenced in manifest but missing on disk: ${manifest.icons[size]}`);
      }
    });
  }

  (manifest.content_scripts || []).forEach((cs, i) => {
    (cs.js || []).forEach((f) => {
      if (!fs.existsSync(path.join(ROOT, f))) {
        warnings.push(`content_scripts[${i}].js references missing file: ${f}`);
      }
    });
    (cs.css || []).forEach((f) => {
      if (!fs.existsSync(path.join(ROOT, f))) {
        warnings.push(`content_scripts[${i}].css references missing file: ${f}`);
      }
    });
  });

  if (manifest.background && manifest.background.service_worker) {
    if (!fs.existsSync(path.join(ROOT, manifest.background.service_worker))) {
      warnings.push(`background.service_worker references missing file: ${manifest.background.service_worker}`);
    }
  } else {
    warnings.push('No background.service_worker declared.');
  }

  if (manifest.update_url) {
    warnings.push('manifest.json declares update_url — Chrome Web Store assigns its own update URL and will REJECT a package that sets this. Only set update_url for self-hosted/enterprise distribution.');
  }

  // Cross-check API usage in source against declared permissions.
  const declaredPermissions = new Set(manifest.permissions || []);
  const apiUsageMap = {
    'chrome.cookies': 'cookies',
    'chrome.storage': 'storage',
    'chrome.scripting': 'scripting'
  };
  const sourceFiles = ['background.js', 'content.js', 'overlay.js'].filter((f) =>
    fs.existsSync(path.join(ROOT, f))
  );
  const combinedSource = sourceFiles
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');

  Object.entries(apiUsageMap).forEach(([apiCall, permission]) => {
    if (combinedSource.includes(apiCall) && !declaredPermissions.has(permission)) {
      warnings.push(`Source code calls ${apiCall}(...) but "${permission}" is not in manifest.permissions.`);
    }
  });

  return warnings;
}

// ---------------------------------------------------------------------------
// Step 3/4: build dist/ with minified copies
// ---------------------------------------------------------------------------

/** Strips /* *\/ block comments and collapses blank lines/leading whitespace. Not a real minifier. */
function regexMinifyJS(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function regexMinifyCSS(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '') // comments
    .replace(/\s*([{}:;,])\s*/g, '$1') // trim around punctuation
    .replace(/;}/g, '}') // drop trailing semicolon before close brace
    .replace(/\n+/g, '')
    .trim();
}

async function minifyJS(code) {
  if (isModuleAvailable('esbuild')) {
    const esbuild = require('esbuild');
    return esbuild.transformSync(code, { minify: true, loader: 'js', target: 'chrome100' }).code;
  }
  if (isModuleAvailable('terser')) {
    const terser = require('terser');
    const result = await terser.minify(code);
    if (result.error) throw result.error;
    return result.code;
  }
  console.warn('  (no esbuild/terser found — using light regex-based JS minifier; run `npm install --save-dev esbuild` for real minification)');
  return regexMinifyJS(code);
}

async function minifyCSS(code) {
  if (isModuleAvailable('esbuild')) {
    const esbuild = require('esbuild');
    return esbuild.transformSync(code, { minify: true, loader: 'css' }).code;
  }
  console.warn('  (no esbuild found — using light regex-based CSS minifier; run `npm install --save-dev esbuild` for real minification)');
  return regexMinifyCSS(code);
}

async function buildDist(manifest) {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });

  // manifest.json — compacted, not minified (must stay valid strict JSON)
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // The grant-access page is copied verbatim below, not minified, so its
  // HTML/JS pairing stays trivially auditable for Chrome Web Store review.
  fs.copyFileSync(path.join(ROOT, 'grant-access.html'), path.join(DIST, 'grant-access.html'));
  fs.copyFileSync(path.join(ROOT, 'grant-access.js'), path.join(DIST, 'grant-access.js'));

  const jsFiles = ['background.js', 'content.js', 'overlay.js'];
  for (const file of jsFiles) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const minified = await minifyJS(src);
    fs.writeFileSync(path.join(DIST, file), minified);
    console.log(`  ${file}: ${src.length} -> ${minified.length} bytes`);
  }

  const cssSrc = fs.readFileSync(path.join(ROOT, 'overlay.css'), 'utf8');
  const cssMin = await minifyCSS(cssSrc);
  fs.writeFileSync(path.join(DIST, 'overlay.css'), cssMin);
  console.log(`  overlay.css: ${cssSrc.length} -> ${cssMin.length} bytes`);

  ['icon16.png', 'icon48.png', 'icon128.png'].forEach((icon) => {
    fs.copyFileSync(path.join(ROOT, 'icons', icon), path.join(DIST, 'icons', icon));
  });

  console.log(`✓ dist/ built`);
}

// ---------------------------------------------------------------------------
// Step 5: zip dist/ — hand-rolled ZIP writer (no dependency required)
// ---------------------------------------------------------------------------

function makeCrcTable() {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function listFilesRecursive(dir, baseDir = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(listFilesRecursive(full, baseDir));
    } else {
      files.push({ name: path.relative(baseDir, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
    }
  }
  return files;
}

/** Builds a valid ZIP archive (STORE or DEFLATE per-entry) from in-memory file entries. */
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data);
    const useDeflate = deflated.length < entry.data.length;
    const method = useDeflate ? 8 : 0;
    const compData = useDeflate ? deflated : entry.data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compData.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuf, compData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compData.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0x81a40000, 38); // external attrs (regular file, 644)
    centralHeader.writeUInt32LE(offset, 42); // offset of local header

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compData.length;
  }

  const centralDirStart = offset;
  const centralDirBuffer = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuffer, eocd]);
}

function zipDist(version) {
  const entries = listFilesRecursive(DIST);
  const zipBuffer = buildZip(entries);
  const zipName = `permission-detective-v${version}.zip`;
  fs.writeFileSync(path.join(ROOT, zipName), zipBuffer);
  console.log(`✓ ${zipName} written (${zipBuffer.length} bytes, ${entries.length} files)`);
  return zipName;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Permission Detective — build\n');

  checkRequiredFiles();

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const warnings = validateManifest(manifest);

  console.log('\nBuilding dist/ ...');
  await buildDist(manifest);

  console.log('\nPackaging zip ...');
  const zipName = zipDist(manifest.version);

  console.log('\n--- Manifest validation warnings ---');
  if (warnings.length === 0) {
    console.log('✓ No warnings');
  } else {
    warnings.forEach((w) => console.warn(`⚠ ${w}`));
  }

  console.log(`\nDone. Upload ${zipName} to the Chrome Web Store Developer Dashboard.`);
}

main().catch((err) => {
  console.error('\n✖ Build failed:', err);
  process.exit(1);
});
