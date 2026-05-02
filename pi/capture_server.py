#!/usr/bin/env python3
import json
import logging
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)


def pick_binary(*names: str) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def run_command(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    logging.info("Running: %s", " ".join(command))
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def repo_relative(path: Path, repo_dir: Path) -> str:
    return path.relative_to(repo_dir).as_posix()


@dataclass
class Config:
    host: str = os.environ.get("FUGLEHUS_HOST", "0.0.0.0")
    port: int = int(os.environ.get("FUGLEHUS_PORT", "8080"))
    repo_dir: Path = Path(os.environ.get("FUGLEHUS_REPO_DIR", "/home/pi/fuglehus")).expanduser()
    image_width: int = int(os.environ.get("FUGLEHUS_IMAGE_WIDTH", "1920"))
    image_height: int = int(os.environ.get("FUGLEHUS_IMAGE_HEIGHT", "1080"))
    image_quality: int = int(os.environ.get("FUGLEHUS_IMAGE_QUALITY", "92"))
    video_width: int = int(os.environ.get("FUGLEHUS_VIDEO_WIDTH", "1280"))
    video_height: int = int(os.environ.get("FUGLEHUS_VIDEO_HEIGHT", "720"))
    video_duration: int = int(os.environ.get("FUGLEHUS_VIDEO_DURATION", "15"))
    video_framerate: int = int(os.environ.get("FUGLEHUS_VIDEO_FRAMERATE", "25"))
    video_bitrate: int = int(os.environ.get("FUGLEHUS_VIDEO_BITRATE", "2500000"))
    queue_limit: int = int(os.environ.get("FUGLEHUS_QUEUE_LIMIT", "4"))
    git_remote: str = os.environ.get("FUGLEHUS_GIT_REMOTE", "origin")
    git_branch: str = os.environ.get("FUGLEHUS_GIT_BRANCH", "main")
    git_author_name: str = os.environ.get("FUGLEHUS_GIT_AUTHOR_NAME", "Fuglehus Pi")
    git_author_email: str = os.environ.get("FUGLEHUS_GIT_AUTHOR_EMAIL", "pi@fuglehus.local")


CONFIG = Config()
STILL_BIN = pick_binary("rpicam-still", "libcamera-still")
VIDEO_BIN = pick_binary("rpicam-vid", "libcamera-vid")
FFMPEG_BIN = pick_binary("ffmpeg")
JOB_QUEUE: "queue.Queue[dict[str, Any]]" = queue.Queue()
STATE = {
    "busy": False,
    "current_job_id": None,
    "last_success": None,
    "last_error": None,
}


def ensure_environment() -> None:
    if not CONFIG.repo_dir.exists():
        raise FileNotFoundError(f"Repo directory not found: {CONFIG.repo_dir}")
    if not (CONFIG.repo_dir / ".git").exists():
        raise FileNotFoundError(f"Repo directory is not a git checkout: {CONFIG.repo_dir}")
    if not STILL_BIN:
        raise FileNotFoundError("Could not find rpicam-still or libcamera-still on the Pi.")
    if not VIDEO_BIN:
        raise FileNotFoundError("Could not find rpicam-vid or libcamera-vid on the Pi.")
    if not FFMPEG_BIN:
        raise FileNotFoundError("Could not find ffmpeg on the Pi.")


def git_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("GIT_AUTHOR_NAME", CONFIG.git_author_name)
    env.setdefault("GIT_AUTHOR_EMAIL", CONFIG.git_author_email)
    env.setdefault("GIT_COMMITTER_NAME", CONFIG.git_author_name)
    env.setdefault("GIT_COMMITTER_EMAIL", CONFIG.git_author_email)
    return env


def run_git(args: list[str]) -> subprocess.CompletedProcess[str]:
    command = ["git", "-C", str(CONFIG.repo_dir), *args]
    logging.info("Running git: %s", " ".join(command))
    return subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        env=git_env(),
    )


def copy_into_repo(source: Path, target_subdir: str) -> Path:
    target_dir = CONFIG.repo_dir / target_subdir
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / source.name
    shutil.copy2(source, target_path)
    return target_path


def push_file(target_path: Path, commit_message: str) -> None:
    relative_path = repo_relative(target_path, CONFIG.repo_dir)
    run_git(["pull", "--rebase", CONFIG.git_remote, CONFIG.git_branch])
    run_git(["add", relative_path])
    run_git(["commit", "-m", commit_message])
    run_git(["push", CONFIG.git_remote, CONFIG.git_branch])


def timestamp_now() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def capture_image(job: dict[str, Any]) -> dict[str, Any]:
    width = int(job.get("width") or CONFIG.image_width)
    height = int(job.get("height") or CONFIG.image_height)
    quality = int(job.get("quality") or CONFIG.image_quality)
    stamp = timestamp_now()

    with tempfile.TemporaryDirectory(prefix="fuglehus-image-") as temp_dir:
        temp_path = Path(temp_dir) / f"bilde_{stamp}.jpg"
        command = [
            STILL_BIN,
            "--nopreview",
            "--timeout",
            "1000",
            "--width",
            str(width),
            "--height",
            str(height),
            "--quality",
            str(quality),
            "--encoding",
            "jpg",
            "-o",
            str(temp_path),
        ]
        run_command(command)
        target_path = copy_into_repo(temp_path, "")
        push_file(target_path, f"Bilde {stamp}")

    return {
        "type": "image",
        "file": target_path.name,
        "width": width,
        "height": height,
    }


def capture_video(job: dict[str, Any]) -> dict[str, Any]:
    duration = max(1, int(job.get("duration") or CONFIG.video_duration))
    width = int(job.get("width") or CONFIG.video_width)
    height = int(job.get("height") or CONFIG.video_height)
    bitrate_raw = job.get("bitrate") or CONFIG.video_bitrate
    framerate = int(job.get("framerate") or CONFIG.video_framerate)
    output_format = str(job.get("format") or "mp4").lower()

    if output_format != "mp4":
        raise ValueError("Only mp4 output is supported.")

    if isinstance(bitrate_raw, str) and bitrate_raw.endswith("k"):
        bitrate = int(bitrate_raw[:-1]) * 1000
    else:
        bitrate = int(bitrate_raw)

    stamp = timestamp_now()

    with tempfile.TemporaryDirectory(prefix="fuglehus-video-") as temp_dir:
        raw_path = Path(temp_dir) / f"klipp_{stamp}.h264"
        mp4_path = Path(temp_dir) / f"klipp_{stamp}.mp4"

        capture_command = [
            VIDEO_BIN,
            "--nopreview",
            "--timeout",
            str(duration * 1000),
            "--width",
            str(width),
            "--height",
            str(height),
            "--framerate",
            str(framerate),
            "--bitrate",
            str(bitrate),
            "-o",
            str(raw_path),
        ]
        run_command(capture_command)

        remux_command = [
            FFMPEG_BIN,
            "-y",
            "-framerate",
            str(framerate),
            "-i",
            str(raw_path),
            "-c:v",
            "copy",
            "-movflags",
            "+faststart",
            str(mp4_path),
        ]
        run_command(remux_command)

        target_path = copy_into_repo(mp4_path, "video")
        push_file(target_path, f"Video {stamp}")

    return {
        "type": "video",
        "file": target_path.name,
        "duration": duration,
        "width": width,
        "height": height,
        "bitrate": bitrate,
    }


def worker_loop() -> None:
    while True:
        job = JOB_QUEUE.get()
        STATE["busy"] = True
        STATE["current_job_id"] = job["id"]

        try:
            if job["kind"] == "image":
                result = capture_image(job["payload"])
            elif job["kind"] == "video":
                result = capture_video(job["payload"])
            else:
                raise ValueError(f"Unknown job kind: {job['kind']}")

            STATE["last_success"] = {
                "jobId": job["id"],
                "kind": job["kind"],
                "finishedAt": datetime.now().isoformat(),
                "result": result,
            }
            STATE["last_error"] = None
            logging.info("Completed job %s", job["id"])
        except Exception as exc:  # noqa: BLE001
            STATE["last_error"] = {
                "jobId": job["id"],
                "kind": job["kind"],
                "finishedAt": datetime.now().isoformat(),
                "message": str(exc),
            }
            logging.exception("Job %s failed", job["id"])
        finally:
            STATE["busy"] = False
            STATE["current_job_id"] = None
            JOB_QUEUE.task_done()


class Handler(BaseHTTPRequestHandler):
    server_version = "FuglehusPi/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)

    def json_response(self, data: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length == 0:
            return {}
        raw_body = self.rfile.read(content_length)
        if not raw_body:
            return {}
        return json.loads(raw_body.decode("utf-8"))

    def enqueue_job(self, kind: str, payload: dict[str, Any]) -> None:
        if JOB_QUEUE.qsize() >= CONFIG.queue_limit:
            self.json_response(
                {"success": False, "error": "Queue is full. Try again shortly."},
                HTTPStatus.TOO_MANY_REQUESTS,
            )
            return

        job_id = str(uuid.uuid4())
        JOB_QUEUE.put({"id": job_id, "kind": kind, "payload": payload})
        self.json_response(
            {
                "success": True,
                "queued": True,
                "jobId": job_id,
                "kind": kind,
                "queueSize": JOB_QUEUE.qsize(),
            },
            HTTPStatus.ACCEPTED,
        )

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self.json_response(
                {
                    "ok": True,
                    "busy": STATE["busy"],
                    "queueSize": JOB_QUEUE.qsize(),
                    "currentJobId": STATE["current_job_id"],
                    "lastSuccess": STATE["last_success"],
                    "lastError": STATE["last_error"],
                }
            )
            return

        self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        try:
            payload = self.read_json()
        except json.JSONDecodeError:
            self.json_response({"success": False, "error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
            return

        if self.path == "/api/capture":
            self.enqueue_job("image", payload)
            return

        if self.path == "/api/video-capture":
            self.enqueue_job("video", payload)
            return

        self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)


def main() -> None:
    ensure_environment()
    worker = threading.Thread(target=worker_loop, daemon=True)
    worker.start()

    server = ThreadingHTTPServer((CONFIG.host, CONFIG.port), Handler)
    logging.info("Fuglehus Pi API listening on http://%s:%s", CONFIG.host, CONFIG.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
