from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from flask import jsonify, request


REPO_DIR = Path("/home/torbjorn/fuglehus")
VIDEO_DIR = REPO_DIR / "video"
LENS_POSITION = "4.7"
DEFAULT_VIDEO_WIDTH = 1920
DEFAULT_VIDEO_HEIGHT = 1080
DEFAULT_VIDEO_DURATION = 15
DEFAULT_VIDEO_BITRATE = "1800k"
DEFAULT_VIDEO_FRAMERATE = 25
JOB_SCRIPT_PATH = Path("/home/torbjorn/kamera/video_capture_job.py")
LOCKFILE_PATH = Path("/tmp/fuglehus-video-capture.lock")
VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov", ".m4v")


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def git_sync_and_push(relative_path: str, commit_message: str) -> None:
    run(["git", "pull", "--rebase", "-X", "ours", "origin", "main"], cwd=REPO_DIR)
    run(["git", "add", relative_path], cwd=REPO_DIR)
    run(["git", "commit", "-m", commit_message], cwd=REPO_DIR)
    run(["git", "push", "origin", "main"], cwd=REPO_DIR)


def queue_video_job(
    duration: int = DEFAULT_VIDEO_DURATION,
    width: int = DEFAULT_VIDEO_WIDTH,
    height: int = DEFAULT_VIDEO_HEIGHT,
    bitrate: str = DEFAULT_VIDEO_BITRATE,
    framerate: int = DEFAULT_VIDEO_FRAMERATE,
) -> str:
    if LOCKFILE_PATH.exists():
        raise RuntimeError("Et videoopptak er allerede i gang.")
    if not JOB_SCRIPT_PATH.is_file():
        raise RuntimeError(f"Fant ikke jobbscriptet: {JOB_SCRIPT_PATH}")

    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    job_id = datetime.now().strftime("%Y%m%d%H%M%S")
    command = [
        "python3",
        str(JOB_SCRIPT_PATH),
        "--duration",
        str(duration),
        "--width",
        str(width),
        "--height",
        str(height),
        "--bitrate",
        str(bitrate),
        "--framerate",
        str(framerate),
    ]

    subprocess.Popen(
        command,
        cwd="/home/torbjorn/kamera",
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return job_id


def git_delete_file(relative_path: str, commit_message: str) -> None:
    run(["git", "pull", "--rebase", "-X", "ours", "origin", "main"], cwd=REPO_DIR)
    run(["git", "rm", "-f", relative_path], cwd=REPO_DIR)
    run(["git", "commit", "-m", commit_message], cwd=REPO_DIR)
    run(["git", "push", "origin", "main"], cwd=REPO_DIR)


def register_video_routes(app):
    @app.post("/api/video-capture")
    def video_capture():
        payload = request.get_json(silent=True) or {}

        try:
            duration = int(payload.get("duration", DEFAULT_VIDEO_DURATION))
            width = int(payload.get("width", DEFAULT_VIDEO_WIDTH))
            height = int(payload.get("height", DEFAULT_VIDEO_HEIGHT))
            bitrate = str(payload.get("bitrate", DEFAULT_VIDEO_BITRATE))
            framerate = int(payload.get("framerate", DEFAULT_VIDEO_FRAMERATE))

            job_id = queue_video_job(
                duration=duration,
                width=width,
                height=height,
                bitrate=bitrate,
                framerate=framerate,
            )

            return jsonify(
                {
                    "success": True,
                    "queued": True,
                    "jobId": job_id,
                    "duration": duration,
                    "width": width,
                    "height": height,
                    "bitrate": bitrate,
                }
            ), 202
        except Exception as exc:  # noqa: BLE001
            return jsonify({"success": False, "error": str(exc)}), 500

    @app.post("/api/video-delete")
    def video_delete():
        if LOCKFILE_PATH.exists():
            return jsonify({"success": False, "error": "Et videoopptak er allerede i gang."}), 409

        payload = request.get_json(silent=True) or {}
        name = Path(str(payload.get("name", ""))).name

        if not name or not name.lower().endswith(VIDEO_EXTENSIONS):
            return jsonify({"success": False, "error": "Ugyldig videonavn."}), 400

        path = VIDEO_DIR / name
        if not path.is_file():
            return jsonify({"success": False, "error": "Fant ikke videoklippet."}), 404

        try:
            git_delete_file(f"video/{name}", f"Slett video {name}")
            return jsonify({"success": True, "filename": name})
        except Exception as exc:  # noqa: BLE001
            return jsonify({"success": False, "error": str(exc)}), 500
