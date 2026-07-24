#!/usr/bin/env python3
"""Pause/restart production Hugging Face Spaces on an Eastern-time schedule.

Expected environment:
  HF_TOKEN              Hugging Face token with write access to the Spaces.
  HF_SPACE_REPO_IDS     Comma-separated Space repo ids. Defaults to prod backend
                        and proxy for this project.
  HF_SCHEDULE_TZ        IANA timezone. Defaults to America/New_York.
  HF_PAUSE_AT           Local wall time HH:MM. Defaults to 20:00.
  HF_WAKE_AT            Local wall time HH:MM. Defaults to 06:45.
  HF_ACTION_WINDOW_MIN  Legacy compatibility only; schedule mode now ensures
                        daytime awake and nighttime paused.
  HF_WARMUP_URL         Optional POST URL to warm after wake/restart.
  HF_WARMUP_REQUIRED    Set to 1/true if warmup failure should fail the workflow.
  APP_USERNAME          Optional app username for warmup payload.
  APP_PASSWORD          Optional app password for warmup payload.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, time as day_time
from typing import Iterable
from urllib import request
from urllib.error import HTTPError, URLError
from zoneinfo import ZoneInfo

from huggingface_hub import HfApi


DEFAULT_SPACES = (
    "PPAL-SongLab-UGA/fruit-analyzer",
    "PPAL-SongLab-UGA/watermelon-proxy",
)
DEFAULT_WARMUP_URL = "https://ppal-songlab-uga-watermelon-proxy.hf.space/proxy_warmup"


def env_list(name: str, default: Iterable[str]) -> list[str]:
    raw = os.getenv(name, "")
    values = [item.strip() for item in raw.split(",") if item.strip()]
    return values or list(default)


def parse_hhmm(value: str) -> day_time:
    hour, minute = [int(part) for part in value.strip().split(":", 1)]
    return day_time(hour=hour, minute=minute)


def minutes_since_midnight(t: day_time) -> int:
    return t.hour * 60 + t.minute


def in_window(now_local: datetime, start: day_time, window_minutes: int) -> bool:
    now_min = minutes_since_midnight(now_local.time())
    start_min = minutes_since_midnight(start)
    end_min = start_min + max(1, window_minutes)
    if end_min < 24 * 60:
        return start_min <= now_min < end_min
    return now_min >= start_min or now_min < (end_min % (24 * 60))


def runtime_stage(api: HfApi, repo_id: str) -> str:
    try:
        runtime = api.get_space_runtime(repo_id=repo_id)
        stage = getattr(runtime, "stage", None)
        if stage is None and isinstance(runtime, dict):
            stage = runtime.get("stage")
        return str(stage or "unknown").upper()
    except Exception as exc:  # noqa: BLE001
        print(f"[status] {repo_id}: could not read runtime ({type(exc).__name__}: {exc})")
        return "unknown"


def pause_spaces(api: HfApi, repo_ids: list[str]) -> None:
    for repo_id in repo_ids:
        stage = runtime_stage(api, repo_id)
        if stage in {"PAUSED", "STOPPED"}:
            print(f"[pause] {repo_id}: already {stage.lower()}")
            continue
        print(f"[pause] {repo_id}: current stage={stage}; pausing")
        api.pause_space(repo_id=repo_id)


def wake_spaces(api: HfApi, repo_ids: list[str]) -> bool:
    restarted_any = False
    for repo_id in repo_ids:
        stage = runtime_stage(api, repo_id)
        if stage in {"RUNNING", "STARTING", "BUILDING"}:
            print(f"[wake] {repo_id}: already {stage.lower()}")
            continue
        print(f"[wake] {repo_id}: current stage={stage}; restarting")
        api.restart_space(repo_id=repo_id)
        restarted_any = True
    return restarted_any


def post_warmup(retries: int = 6, delay_s: int = 20) -> None:
    url = (os.getenv("HF_WARMUP_URL") or DEFAULT_WARMUP_URL).strip()
    username = os.getenv("APP_USERNAME", "").strip()
    password = os.getenv("APP_PASSWORD", "")
    if not url:
        print("[warmup] skipped: HF_WARMUP_URL is blank")
        return
    if not username or not password:
        print("[warmup] skipped: APP_USERNAME and APP_PASSWORD are required")
        return

    payload = json.dumps({
        "username": username,
        "password": password,
        "fruit_type": os.getenv("HF_WARMUP_FRUIT", "watermelon"),
        "expert_id": os.getenv("HF_WARMUP_EXPERT_ID", ""),
    }).encode("utf-8")
    headers = {"content-type": "application/json"}
    req = request.Request(url, data=payload, headers=headers, method="POST")

    for attempt in range(1, retries + 1):
        try:
            with request.urlopen(req, timeout=40) as response:
                body = response.read().decode("utf-8", errors="replace")
            print(f"[warmup] success on attempt {attempt}: {body[:500]}")
            return
        except (HTTPError, URLError, TimeoutError) as exc:
            print(f"[warmup] attempt {attempt}/{retries} failed: {type(exc).__name__}: {exc}")
            if attempt < retries:
                time.sleep(delay_s)
    message = "Warmup failed after all retries."
    if os.getenv("HF_WARMUP_REQUIRED", "").strip().lower() in {"1", "true", "yes"}:
        raise RuntimeError(message)
    print(f"[warmup] warning: {message}")


def scheduled_action() -> str:
    tz = ZoneInfo(os.getenv("HF_SCHEDULE_TZ", "America/New_York"))
    now_local = datetime.now(tz)
    pause_at = parse_hhmm(os.getenv("HF_PAUSE_AT", "20:00"))
    wake_at = parse_hhmm(os.getenv("HF_WAKE_AT", "06:45"))

    print(f"[schedule] local time={now_local.isoformat(timespec='seconds')}")
    now_min = minutes_since_midnight(now_local.time())
    pause_min = minutes_since_midnight(pause_at)
    wake_min = minutes_since_midnight(wake_at)

    if wake_min <= pause_min:
        return "wake" if wake_min <= now_min < pause_min else "pause"
    return "pause" if pause_min <= now_min < wake_min else "wake"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["schedule", "pause", "wake", "status"], default="schedule")
    args = parser.parse_args()

    token = os.getenv("HF_TOKEN", "").strip()
    if not token:
        raise RuntimeError("HF_TOKEN is required.")

    repo_ids = env_list("HF_SPACE_REPO_IDS", DEFAULT_SPACES)
    action = scheduled_action() if args.action == "schedule" else args.action
    print(f"[main] action={action}; spaces={', '.join(repo_ids)}")

    api = HfApi(token=token)
    if action == "pause":
        pause_spaces(api, repo_ids)
    elif action == "wake":
        restarted = wake_spaces(api, repo_ids)
        if restarted:
            time.sleep(int(os.getenv("HF_POST_RESTART_WAIT_S", "60")))
        post_warmup()
    else:
        for repo_id in repo_ids:
            print(f"[status] {repo_id}: {runtime_stage(api, repo_id)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
