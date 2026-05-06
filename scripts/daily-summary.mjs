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
const FROST_CLIENT_ID = process.env.FROST_CLIENT_ID || '';
const FROST_SOURCE_ID = process.env.FROST_SOURCE_ID || '';
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

function nextDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
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

function buildWeatherNote(weather) {
  if (!weather) return null;

  const parts = [];
  if (typeof weather.temperature === 'number') {
    parts.push(`snittemperatur rundt ${Math.round(weather.temperature)} °C`);
  }
  if (typeof weather.wind === 'number') {
    parts.push(`vind omkring ${Math.round(weather.wind)} m/s`);
  }
  if (typeof weather.precipitation === 'number') {
    if (weather.precipitation > 0.2) {
      parts.push(`omtrent ${weather.precipitation.toFixed(1)} mm nedbør`);
    } else {
      parts.push('lite eller ingen nedbør');
    }
  }

  return parts.length ? parts.join(', ') : null;
}

async function fetchHistoricalWeather(targetDate) {
  if (!FROST_CLIENT_ID || !FROST_SOURCE_ID) return null;

  const params = new URLSearchParams({
    sources: FROST_SOURCE_ID,
    referencetime: `${targetDate}/${nextDate(targetDate)}`,
    elements: 'mean(air_temperature%20P1D),sum(precipitation_amount%20P1D),mean(wind_speed%20P1D)',
    levels: 'default',
    timeoffsets: 'default',
  });

  const auth = Buffer.from(`${FROST_CLIENT_ID}:`).toString('base64');
  const response = await fetch(`https://frost.met.no/observations/v0.jsonld?${params.toString()}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Frost-feil ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const weather = {};

  for (const row of rows) {
    for (const observation of row.observations || []) {
      const element = String(observation.elementId || '');
      if (element.startsWith('mean(air_temperature')) weather.temperature = Number(observation.value);
      if (element.startsWith('sum(precipitation_amount')) weather.precipitation = Number(observation.value);
      if (element.startsWith('mean(wind_speed')) weather.wind = Number(observation.value);
    }
  }

  return Object.keys(weather).length ? weather : null;
}

function mergeSelectedWithFavorites(selectedImages, dayFavorites, maxImages) {
  const merged = new Map();
  dayFavorites.forEach((image) => merged.set(image.name, image));
  selectedImages.forEach((image) => merged.set(image.name, image));
  return [...merged.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .slice(0, Math.max(maxImages, dayFavorites.length));
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
  const first = selectedImages[0]?.time || selectedImages[0]?.timestamp?.label || 'tidlig på dagen';
  const last = selectedImages.at(-1)?.time || selectedImages.at(-1)?.timestamp?.label || 'senere på dagen';
  return {
    source: 'fallback',
    summary: `Else var innom flere ganger i løpet av dagen, fra omtrent ${first} til ${last}. Aktiviteten virker jevnt fordelt gjennom dagen, med mest liv i de lyseste timene.`,
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

async function callOpenAiJson(content, systemPrompt, max_tokens = 600) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
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

  return tryParseJson(text);
}

async function classifyElseVisibility(targetDate, selectedImages) {
  if (!OPENAI_API_KEY) {
    return selectedImages.map((image) => ({
      ...image,
      else_visible: image.favorite,
      visibility_confidence: image.favorite ? 0.9 : 0.2,
    }));
  }

  const content = [
    {
      type: 'text',
      text:
        `Du skal klassifisere om kjøttmeisen Else faktisk er synlig i hvert bilde fra ${targetDate}. ` +
        `Svar KUN med gyldig JSON på formen {"images":[{"name":"...","else_visible":true,"visibility_confidence":0.0}]}. ` +
        `else_visible skal bare være true når fuglen faktisk er synlig i eller ved fuglehuset. ` +
        `Bruk false for tom kasse, bare miljø eller når du er usikker. ` +
        `visibility_confidence skal være et tall mellom 0 og 1.`,
    },
  ];

  selectedImages.forEach((image, index) => {
    content.push({
      type: 'text',
      text: `Bilde ${index + 1}: filename=${image.name}, tidspunkt=${image.timestamp.label}${image.favorite ? ', favoritt=ja' : ''}`,
    });
    content.push({
      type: 'image_url',
      image_url: { url: image.raw_url },
    });
  });

  const parsed = await callOpenAiJson(
    content,
    'Du er svært nøyaktig på visuell klassifisering av om en fugl faktisk er synlig i et bilde.'
  );

  const visibilityMap = new Map(
    (parsed.images || [])
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => [
        entry.name,
        {
          else_visible: Boolean(entry.else_visible),
          visibility_confidence: Math.max(0, Math.min(1, Number(entry.visibility_confidence) || 0)),
        },
      ])
  );

  return selectedImages.map((image) => {
    const match = visibilityMap.get(image.name);
    return {
      ...image,
      else_visible: match?.else_visible ?? false,
      visibility_confidence: match?.visibility_confidence ?? 0,
    };
  });
}

async function generateAiSummary(targetDate, images, selectedImages, weatherNote) {
  if (!OPENAI_API_KEY) {
    return buildFallbackSummary(targetDate, images, selectedImages);
  }

  const content = [
    {
      type: 'text',
      text:
        `Du lager en kort norsk oppsummering av dagens aktivitet i en fuglekasse. ` +
        `Bildene er fra ${targetDate} og viser aktivitet rundt kjøttmeisen Else. ` +
        `Oppsummer kort hvor mye hun ser ut til å ha vært innom, og om aktiviteten virker størst tidlig på dagen, midt på dagen eller sent. ` +
        `Hvis historiske værdata finnes, ta med én kort og faktuell observasjon om værforholdene den dagen. ` +
        `Tonen skal være nøktern, kort og lett tilgjengelig. ` +
        `Ikke dikt opp konkrete hendelser, værforhold eller besøk som ikke kan støttes av bildene. ` +
        `${weatherNote ? `Bruk denne historiske værobservasjonen som faktagrunnlag når den passer med bildene: ${weatherNote}. ` : ''}` +
        `Velg et hero_image der Else faktisk er tydelig synlig, og prioriter nærvær, kropp eller hode fremfor tom kasse eller bare miljø. ` +
        `Hvis flere bilder viser Else, velg det bildet der hun fremstår tydeligst og mest sentralt. ` +
        `Hvis flere bilder viser Else tydelig, velg det som best føles som dagens høydepunkt. ` +
        `Svar KUN med gyldig JSON med feltene: summary, hero_image. ` +
        `summary skal være 2 til 3 korte setninger på norsk. ` +
        `hero_image må være nøyaktig ett av filnavnene du får oppgitt.`,
    },
  ];

  selectedImages.forEach((image, index) => {
    content.push({
      type: 'text',
      text:
        `Bilde ${index + 1}: filename=${image.name}, tidspunkt=${image.timestamp.label}` +
        `${image.favorite ? ', favoritt=ja' : ''}` +
        `${image.else_visible ? `, else_visible=ja, confidence=${image.visibility_confidence}` : ', else_visible=nei'}`,
    });
    content.push({
      type: 'image_url',
      image_url: { url: image.raw_url },
    });
  });

  const parsed = await callOpenAiJson(
    content,
    'Du er en naturjournalist som skriver korte, presise oppsummeringer av aktivitet i en fuglekasse.'
  );

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

  const favorites = await fetchFavorites();
  const weather = await fetchHistoricalWeather(TARGET_DATE).catch(() => null);
  const weatherNote = buildWeatherNote(weather);
  const favoriteImagesForDay = images.filter((image) => favorites.includes(image.name));
  const baseImages = mergeSelectedWithFavorites(
    selectImages(images, MAX_SELECTED_IMAGES),
    favoriteImagesForDay,
    MAX_SELECTED_IMAGES
  );

  let selectedImages = baseImages.map((image) => ({
    ...image,
    favorite: favorites.includes(image.name),
  }));

  selectedImages = await classifyElseVisibility(TARGET_DATE, selectedImages);
  const confirmedElseImages = selectedImages
    .filter((image) => image.else_visible)
    .sort((a, b) => (b.visibility_confidence || 0) - (a.visibility_confidence || 0) || a.name.localeCompare(b.name, 'en'));
  const summaryImages = selectedImages;
  const heroCandidates = confirmedElseImages.length ? confirmedElseImages : selectedImages;

  const aiSummary = await generateAiSummary(TARGET_DATE, images, summaryImages, weatherNote);
  const aiHeroName = heroCandidates.some((image) => image.name === aiSummary.hero_image)
    ? aiSummary.hero_image
    : null;
  const fallbackFavoriteHero = confirmedElseImages.find((image) => image.favorite)?.name || favoriteImagesForDay[0]?.name || null;
  const heroImageName = aiHeroName || fallbackFavoriteHero || heroCandidates[0]?.name || null;
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
      favorite: Boolean(image.favorite),
      else_visible: Boolean(image.else_visible),
      visibility_confidence: image.visibility_confidence ?? 0,
    })),
    hero_image: heroImage?.name || null,
    hero_image_download_url: heroImage?.download_url || null,
    hero_image_time: heroImage?.timestamp.label || null,
    summary: aiSummary.summary,
    used_favorite_hero_image: Boolean(fallbackFavoriteHero && heroImage?.name === fallbackFavoriteHero),
    weather: weather ? {
      temperature: weather.temperature ?? null,
      precipitation: weather.precipitation ?? null,
      wind: weather.wind ?? null,
      note: weatherNote,
    } : null,
  };

  await writeSummaryFile(summary);
  console.log(`Oppdatert dagsoppsummering for ${TARGET_DATE} med ${summaryImages.length} bilder i AI-utvalget.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
