# Pi-oppsett for bilde og video

Denne mappa inneholder to veier videre:

- `capture_server.py`: et frittstaende mini-API hvis du vil kjor alt i en separat prosess
- `flask_video_patch.py`: en konkret tilpasning for ditt eksisterende Flask-oppsett i `~/kamera/app.py`

Siden du allerede har dette i drift:

- Flask/Gunicorn pa port 8080
- Cloudflare Tunnel til `cam.kvitrehus.com`
- bilder via `~/kamera/app.py`
- repo i `/home/torbjorn/fuglehus`
- git-strategi `git pull --rebase -X ours origin main`

anbefales `flask_video_patch.py`.

## Flask-varianten

`flask_video_patch.py` er laget for a passe oppsettet du beskrev:

- bruker `/home/torbjorn/fuglehus`
- lagrer video i `/home/torbjorn/fuglehus/video/`
- bruker `rpicam-vid`
- bruker `--autofocus-mode manual --lens-position 4.7`
- bruker `git pull --rebase -X ours origin main`
- bruker en storre sensormodus via `--mode 2304:1296`
- lager `mp4` i `1920x1080`, 15 sek, ca `1800k`
- svarer med en gang fra API-et og lar opptak + git-push kjor videre i bakgrunnen
- kan ogsa slette videoklipp via `POST /api/video-delete`

Prinsippet er:

1. legg hjelpefilene pa Pi-en:
   - `~/kamera/flask_video_patch.py`
   - `~/kamera/video_capture_job.py`
2. importer `register_video_routes` i eksisterende `~/kamera/app.py`
3. kall `register_video_routes(app)` etter at Flask-appen er opprettet
4. restart `fuglekasse.service`

Eksempel i `app.py`:

```python
from flask import Flask
from flask_video_patch import register_video_routes

app = Flask(__name__)

register_video_routes(app)
```

Etter det skal denne virke, og returnere `queued: true` raskt:

```bash
curl -X POST https://cam.kvitrehus.com/api/video-capture \
  -H "Content-Type: application/json" \
  -d '{"duration":15,"width":1280,"height":720,"bitrate":"2500k","format":"mp4"}'
```

Sletting av videoklipp:

```bash
curl -X POST https://cam.kvitrehus.com/api/video-delete \
  -H "Content-Type: application/json" \
  -d '{"name":"klipp_2026-05-02_08-57-09.mp4"}'
```

## Frittstaende server

Hvis du heller vil kjor video/bilde som en egen separat API-prosess, kan du bruke `capture_server.py`.

Den eksponerer:

- `POST /api/capture`
- `POST /api/video-capture`
- `GET /health`

Serveren:

- tar bilde med `rpicam-still` eller `libcamera-still`
- tar opp video med `rpicam-vid` eller `libcamera-vid`
- remuxer video til `mp4` med `ffmpeg`
- legger filer inn i git-repoet
- gjør `git pull --rebase`, `git add`, `git commit` og `git push`
- serialiserer jobbene i en enkel intern ko, slik at to opptak ikke kolliderer

## Forutsetninger

Pi-en trenger:

- Raspberry Pi OS med kamera satt opp
- `git`
- `python3`
- `ffmpeg`
- `rpicam-apps` eller tilsvarende `libcamera-*`-kommandoer
- en lokal clone av dette repoet, for eksempel i `/home/pi/fuglehus`
- git-tilgang til `origin/main`

Eksempel pa installasjon:

```bash
sudo apt update
sudo apt install -y git python3 ffmpeg
```

Bekreft at disse finnes:

```bash
which rpicam-still
which rpicam-vid
which ffmpeg
```

## Klargjor repoet pa Pi

Hvis repoet ikke allerede ligger pa Pi-en:

```bash
cd /home/pi
git clone https://github.com/torbjornsand/fuglehus.git fuglehus
cd fuglehus
```

Sorg for at `git push` fungerer fra Pi-en, enten med SSH-nokkel eller annen autentisering.

## Start lokalt

Kjor serveren manuelt for a teste:

```bash
cd /home/pi/fuglehus
python3 pi/capture_server.py
```

Test sa i et nytt terminalvindu:

```bash
curl http://127.0.0.1:8080/health
curl -X POST http://127.0.0.1:8080/api/capture
curl -X POST http://127.0.0.1:8080/api/video-capture \
  -H "Content-Type: application/json" \
  -d '{"duration":15,"width":1280,"height":720,"bitrate":"2500k","format":"mp4"}'
```

## Systemd-service

Kopier service-fila:

```bash
sudo cp /home/pi/fuglehus/pi/fuglehus-capture.service /etc/systemd/system/fuglehus-capture.service
sudo systemctl daemon-reload
sudo systemctl enable --now fuglehus-capture
```

Se logger:

```bash
journalctl -u fuglehus-capture -f
```

## Domenet `cam.kvitrehus.com`

Cloudflare-worker-en din kaller:

- `https://cam.kvitrehus.com/api/capture`
- `https://cam.kvitrehus.com/api/video-capture`

Sa domenet ma peke til Pi-en eller en reverse proxy foran Pi-en. Hvis du allerede har bilde-endepunktet oppe der, trenger du bare a deploye denne nye serveren bak samme domene, slik at ogsa `/api/video-capture` finnes.

## Nyttige env-vars

Du kan overstyre standardene i service-fila:

- `FUGLEHUS_REPO_DIR`
- `FUGLEHUS_PORT`
- `FUGLEHUS_IMAGE_WIDTH`
- `FUGLEHUS_IMAGE_HEIGHT`
- `FUGLEHUS_IMAGE_QUALITY`
- `FUGLEHUS_VIDEO_WIDTH`
- `FUGLEHUS_VIDEO_HEIGHT`
- `FUGLEHUS_VIDEO_DURATION`
- `FUGLEHUS_VIDEO_FRAMERATE`
- `FUGLEHUS_VIDEO_BITRATE`
- `FUGLEHUS_GIT_AUTHOR_NAME`
- `FUGLEHUS_GIT_AUTHOR_EMAIL`

## Viktig a vite

- Video blir tatt opp som `h264` og remuxet til `mp4` for a holde CPU-belastningen nede.
- Filene pushes til repoet, og GitHub Action-en i prosjektet oppdaterer manifestfilene etterpa.
- Frontend-en din forventer ikke at videoen er ferdig med en gang; den poller etter nytt klipp etter at opptaket er startet.
