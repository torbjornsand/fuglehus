import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'bilder.json');
const filteredManifestPath = path.join(repoRoot, 'bilder-filtrert.json');

const IMAGE_PATTERN = /^bilde_.*\.jpg$/i;
const MAX_DUPLICATE_GAP_MINUTES = 20;
const MIN_KEEP_INTERVAL_MINUTES = 40;
const MAX_SIZE_DELTA_BYTES = 14_000;
const MAX_SIZE_DELTA_RATIO = 0.055;

function parseTimestampFromName(name) {
  const match = name.match(/^bilde_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.jpg$/i);
  if (!match) return null;

  const [, date, hh, mm, ss] = match;
  return new Date(`${date}T${hh}:${mm}:${ss}Z`);
}

function minutesBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}

function buildFilteredManifest(images) {
  const filtered = [];
  let lastKept = null;

  for (const image of images) {
    if (!lastKept) {
      filtered.push(image);
      lastKept = image;
      continue;
    }

    const currentTs = parseTimestampFromName(image.name);
    const lastTs = parseTimestampFromName(lastKept.name);
    const gapMinutes = currentTs && lastTs ? minutesBetween(currentTs, lastTs) : Number.POSITIVE_INFINITY;
    const sizeDelta = Math.abs(image.size - lastKept.size);
    const sizeRatio = lastKept.size > 0 ? sizeDelta / lastKept.size : 1;

    const likelyDuplicate =
      gapMinutes <= MAX_DUPLICATE_GAP_MINUTES &&
      sizeDelta <= MAX_SIZE_DELTA_BYTES &&
      sizeRatio <= MAX_SIZE_DELTA_RATIO;

    const keepForFreshness = gapMinutes >= MIN_KEEP_INTERVAL_MINUTES;

    if (!likelyDuplicate || keepForFreshness) {
      filtered.push(image);
      lastKept = image;
    }
  }

  const lastImage = images.at(-1);
  if (lastImage && filtered.at(-1)?.name !== lastImage.name) {
    filtered.push(lastImage);
  }

  return filtered.map(({ name, download_url }) => ({ name, download_url }));
}

async function buildManifest() {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });

  const images = entries
    .filter((entry) => entry.isFile() && IMAGE_PATTERN.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      download_url: entry.name,
      size: 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  for (const image of images) {
    const stats = await fs.stat(path.join(repoRoot, image.name));
    image.size = stats.size;
  }

  const manifest = images.map(({ name, download_url }) => ({ name, download_url }));
  const filteredManifest = buildFilteredManifest(images);

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(filteredManifestPath, `${JSON.stringify(filteredManifest, null, 2)}\n`, 'utf8');

  console.log(`Updated bilder.json with ${manifest.length} images.`);
  console.log(`Updated bilder-filtrert.json with ${filteredManifest.length} images.`);
}

buildManifest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
