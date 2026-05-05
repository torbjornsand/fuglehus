import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outputDir = path.join(repoRoot, 'dag');
const latestPath = path.join(outputDir, 'latest.json');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const REPO_SLUG = process.env.GITHUB_REPOSITORY || 'torbjornsand/fuglehus';
const REPO_REF = process.env.GITHUB_SHA || 'main';
const MAX_SELECTED_IMAGES = Number(process.env.DAILY_SUMMARY_MAX_IMAGES || 12);
const FAVORITES_URL = process.env.FAVORITES_URL || 'https://fuglehus.torbjs.workers.dev/favorites';
const TARGET_DATE = process.argv.find((arg) => arg.startsWith('--date='))?.split('=')[1] || formatOsloDate(new Date());

function formatOsloDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function parseTimestampFromName(name) {
  const match = name.match(/^bilde_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.jpg$/i);
  if (!match) return null;

  const [, date, hh, mm, ss] = match;
  return {
    date,
    hh: Number(hh),
    mm: Number(mm),
    ss: Number(ss),
    isoLocal: `${date}T${hh}:${mm}:${ss}`,
    minutes: Number(hh) * 60 + Number(mm),
    label: `${hh}:${mm}`,
  };
}

function minutesBetween(a, b) {
  return Math.abs(a.minutes - b.minutes);
}

function escapePathSegment(value) {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildRawUrl(relativePath) {
  return `https://raw.githubusercontent.com/${REPO_SLUG}/${REPO_REF}/${escapePathSegment(relativePath)}`;
}

async function listImagesForDate(targetDate) {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && /^bilde_.*\.jpg$/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(`bilde_${targetDate}_`))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const images = [];
  for (const name of names) {
    const timestamp = parseTimestampFromName(name);
    if (!timestamp) continue;
    const stats = await fs.stat(path.join(repoRoot, name));
    images.push({
      name,
      timestamp,
      size: stats.size,
      raw_url: buildRawUrl(name),
      download_url: name,
    });
  }
  return images;
}

async function fetchFavorites() {
  try {
    const response = await fetch(FAVORITES_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`favorites-${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data.filter((value) => typeof value === 'string');
  } catch {
    return [];
  }
}

function selectImages(images, maxImages) {
  if (images.length <= maxImages) return images;

  const ranked = images.map((image, index) => {
    const prev = images[index - 1];
    const next = images[index + 1];
    const prevDelta = prev ? Math.abs(image.size - prev.size) : image.size;
    const nextDelta = next ? Math.abs(image.size - next.size) : prevDelta;
    const score = prevDelta + nextDelta;
    return { ...image, score, index };
  });

  const selected = new Map();
  const add = (image) => {
    if (image) selected.set(image.name, image);
  };

  add(ranked[0]);
  add(ranked.at(-1));

  const byHour = new Map();
  for (const image of ranked) {
    const hourKey = String(image.timestamp.hh).padStart(2, '0');
    const current = byHour.get(hourKey);
    if (!current || image.score > current.score) {
      byHour.set(hourKey, image);
    }
  }

  for (const image of byHour.values()) {
    add(image);
  }

  const sortedByScore = [...ranked].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  for (const image of sortedByScore) {
    if (selected.size >= maxImages) break;
    const tooClose = [...selected.values()].some((picked) => minutesBetween(picked.timestamp, image.timestamp) < 18);
    if (!tooClose) add(image);
  }

  for (const image of ranked) {
    if (selected.size >= maxImages) break;
    add(image);
  }

  let chosen = [...selected.values()];
  if (chosen.length > maxImages) {
    const mustKeep = new Set([ranked[0]?.name, ranked.at(-1)?.name].filter(Boolean));
    const keep = chosen.filter((image) => mustKeep.has(image.name));
    const rest = chosen
      .filter((image) => !mustKeep.has(image.name))
      .sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name, 'en'))
      .slice(0, Math.max(0, maxImages - keep.length));
    chosen = [...keep, ...rest];
  }

  return chosen.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function buildFallbackSummary(targetDate, images, selectedImages) {
  return {
    source: 'fallback',
    summary: `Kjære dagbok: Jeg hadde en travel dag i fuglehuset og stakk innom flere ganger for å holde orden på prosjektet mitt. Vertene fikk nok følge godt med, men jeg røper bare at reirarbeid fortsatt står høyt på planen.`,
    hero_image: selectedImages[Math.floor(selectedImages.length / 2)]?.name || selectedImages[0]?.name || null,
  };
}

function tryParseJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Fant ikke JSON i modelsvaret');
  }
  return JSON.parse(match[0]);
}

async function generateAiSummary(targetDate, images, selectedImages) {
  if (!OPENAI_API_KEY) {
    return buildFallbackSummary(targetDate, images, selectedImages);
  }

  const content = [
    {
      type: 'text',
      text:
        `Du lager en kort norsk dagboknotis for fuglekassekameraet. ` +
        `Bildene er fra ${targetDate} og viser aktivitet rundt kjøttmeisen Else. ` +
        `Skriv i førsteperson som om Else selv oppsummerer dagen. ` +
        `Tonen kan være lett humoristisk og sjarmerende, men den må fortsatt være tydelig forankret i faktisk aktivitet i bildene. ` +
        `Ikke dikt opp ting som ikke kan støttes av bildene. ` +
        `Svar KUN med gyldig JSON med feltene: summary, hero_image. ` +
        `summary skal være 2 til 4 korte setninger på norsk. ` +
        `hero_image må være nøyaktig ett av filnavnene du får oppgitt.`,
    },
  ];

  selectedImages.forEach((image, index) => {
    content.push({
      type: 'text',
      text: `Bilde ${index + 1}: filename=${image.name}, tidspunkt=${image.timestamp.label}`,
    });
    content.push({
      type: 'image_url',
      image_url: { url: image.raw_url },
    });
  });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        {
          role: 'system',
          content: 'Du er en naturjournalist som skriver korte, presise oppsummeringer av aktivitet i en fuglekasse.',
        },
        {
          role: 'user',
          content,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI-feil ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('Modellen returnerte ikke tekst');
  }

  const parsed = tryParseJson(text);
  return {
    source: 'openai',
    summary: parsed.summary,
    hero_image: parsed.hero_image,
  };
}

async function writeSummaryFile(summary) {
  await fs.mkdir(outputDir, { recursive: true });
  const datedPath = path.join(outputDir, `${summary.date}.json`);
  const payload = `${JSON.stringify(summary, null, 2)}\n`;
  await fs.writeFile(datedPath, payload, 'utf8');
  await fs.writeFile(latestPath, payload, 'utf8');
}

async function main() {
  const images = await listImagesForDate(TARGET_DATE);
  if (!images.length) {
    console.log(`Ingen bilder funnet for ${TARGET_DATE}. Hopper over.`);
    return;
  }

  const selectedImages = selectImages(images, MAX_SELECTED_IMAGES);
  const favorites = await fetchFavorites();
  const favoriteImagesForDay = selectedImages.filter((image) => favorites.includes(image.name));
  const aiSummary = await generateAiSummary(TARGET_DATE, images, selectedImages);
  const favoriteHeroName = favoriteImagesForDay[0]?.name || null;
  const aiHeroName = selectedImages.some((image) => image.name === aiSummary.hero_image)
    ? aiSummary.hero_image
    : null;
  const heroImageName = favoriteHeroName || aiHeroName || selectedImages[0]?.name || null;
  const heroImage = selectedImages.find((image) => image.name === heroImageName) || null;

  const summary = {
    date: TARGET_DATE,
    generated_at: new Date().toISOString(),
    model: aiSummary.source === 'openai' ? MODEL : null,
    source: aiSummary.source,
    selected_images: selectedImages.map((image) => ({
      name: image.name,
      time: image.timestamp.label,
      download_url: image.download_url,
      raw_url: image.raw_url,
    })),
    hero_image: heroImage?.name || null,
    hero_image_download_url: heroImage?.download_url || null,
    hero_image_time: heroImage?.timestamp.label || null,
    summary: aiSummary.summary,
    used_favorite_hero_image: Boolean(favoriteHeroName),
  };

  await writeSummaryFile(summary);
  console.log(`Oppdatert dagsoppsummering for ${TARGET_DATE} med ${selectedImages.length} utvalgte bilder.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
