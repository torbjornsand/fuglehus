import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const archiveDir = path.join(repoRoot, 'arkiv');
const FAVORITES_URL = process.env.FAVORITES_URL || 'https://fuglehus.torbjs.workers.dev/favorites';
const ARCHIVE_AFTER_DAYS = Number.parseInt(process.env.ARCHIVE_AFTER_DAYS || '4', 10);
const IMAGE_PATTERN = /^bilde_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.jpg$/i;

function parseTimestampFromName(name) {
  const match = name.match(IMAGE_PATTERN);
  if (!match) return null;

  const [, date, hh, mm, ss] = match;
  return new Date(`${date}T${hh}:${mm}:${ss}Z`);
}

async function fetchFavorites() {
  const response = await fetch(FAVORITES_URL, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch favorites: ${response.status}`);
  }

  const data = await response.json();

  if (Array.isArray(data)) {
    return new Set(data);
  }

  if (data && Array.isArray(data.favorites)) {
    return new Set(data.favorites);
  }

  throw new Error('Favorites response had unexpected shape');
}

async function archiveOldImages() {
  if (!Number.isFinite(ARCHIVE_AFTER_DAYS) || ARCHIVE_AFTER_DAYS < 1) {
    throw new Error(`Invalid ARCHIVE_AFTER_DAYS: ${ARCHIVE_AFTER_DAYS}`);
  }

  const favorites = await fetchFavorites();
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const cutoffMs = Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  await fs.mkdir(archiveDir, { recursive: true });

  const candidates = entries
    .filter((entry) => entry.isFile() && IMAGE_PATTERN.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      timestamp: parseTimestampFromName(entry.name),
    }))
    .filter((entry) => entry.timestamp && entry.timestamp.getTime() < cutoffMs && !favorites.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  let moved = 0;
  for (const entry of candidates) {
    const from = path.join(repoRoot, entry.name);
    const to = path.join(archiveDir, entry.name);
    await fs.rename(from, to);
    moved += 1;
  }

  console.log(`Archived ${moved} image(s) older than ${ARCHIVE_AFTER_DAYS} day(s).`);
}

archiveOldImages().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
