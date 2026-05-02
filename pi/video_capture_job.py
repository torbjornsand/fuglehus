from __future__ import annotations

import argparse
import fcntl
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


REPO_DIR = Path("/home/torbjorn/fuglehus")
VIDEO_DIR = REPO_DIR / "video"
LOCKFILE_PATH = Path("/tmp/fuglehus-video-capture.lock")
LENS_POSITION = "4.7"
SENSOR_MODE = "2304:1296"


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def git_push_file(relative_path: str, message: str) -> None:
    run(["git", "-C", str(REPO_DIR), "pull", "--rebase", "-X", "ours", "origin", "main"])
    run(["git", "-C", str(REPO_DIR), "add", relative_path])
    run(["git", "-C", str(REPO_DIR), "commit", "-m", message])
    run(["git", "-C", str(REPO_DIR), "push", "origin", "main"])


def capture_and_push_video(duration: int, width: int, height: int, bitrate: str, framerate: int) -> str:
    video_bin = shutil.which("rpicam-vid") or shutil.which("libcamera-vid")
    ffmpeg_bin = shutil.which("ffmpeg")

    if not video_bin:
        raise RuntimeError("Fant ikke rpicam-vid eller libcamera-vid på Pi-en.")
    if not ffmpeg_bin:
        raise RuntimeError("Fant ikke ffmpeg på Pi-en.")

    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    final_name = f"klipp_{stamp}.mp4"
    final_path = VIDEO_DIR / final_name

    with tempfile.TemporaryDirectory(prefix="fuglehus-video-") as tmp_dir:
        tmp_dir_path = Path(tmp_dir)
        raw_path = tmp_dir_path / f"klipp_{stamp}.h264"
        mp4_path = tmp_dir_path / final_name

        run(
            [
                video_bin,
                "--nopreview",
                "--timeout",
                str(duration * 1000),
                "--mode",
                SENSOR_MODE,
                "--width",
                str(width),
                "--height",
                str(height),
                "--framerate",
                str(framerate),
                "--bitrate",
                str(bitrate),
                "--autofocus-mode",
                "manual",
                "--lens-position",
                LENS_POSITION,
                "-o",
                str(raw_path),
            ]
        )

        run(
            [
                ffmpeg_bin,
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
        )

        shutil.copy2(mp4_path, final_path)

    git_push_file(f"video/{final_name}", f"Video {stamp}")
    return final_name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=int, default=15)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--bitrate", default="1800k")
    parser.add_argument("--framerate", type=int, default=25)
    args = parser.parse_args()

    with LOCKFILE_PATH.open("w") as lockfile:
        try:
            fcntl.flock(lockfile.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Videoopptak er allerede i gang.", file=sys.stderr)
            return 1

        capture_and_push_video(
            duration=args.duration,
            width=args.width,
            height=args.height,
            bitrate=str(args.bitrate),
            framerate=args.framerate,
        )

    try:
        LOCKFILE_PATH.unlink(missing_ok=True)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
