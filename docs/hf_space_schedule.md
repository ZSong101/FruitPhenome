# Hugging Face Space Schedule

This repo includes a GitHub Actions workflow that can pause production Hugging
Face Spaces at night and restart/warm them before the workday.

Workflow:

- File: `.github/workflows/hf-space-schedule.yml`
- Script: `scripts/manage_hf_spaces.py`
- Default production Spaces:
  - `PPAL-SongLab-UGA/fruit-analyzer`
  - `PPAL-SongLab-UGA/watermelon-proxy`
- Default schedule:
  - Pause window starts at `8:00 PM America/New_York`
  - Wake window starts at `6:45 AM America/New_York`

## Required GitHub Secrets

Add these in the GitHub repository settings under **Secrets and variables ->
Actions -> Secrets**.

- `HF_SPACE_ADMIN_TOKEN`: Hugging Face token with write access to the production
  Spaces. This must be able to pause/restart the Spaces.
- `APP_USERNAME`: app login username used for production warmup.
- `APP_PASSWORD`: app login password used for production warmup.

## Optional GitHub Variables

Add these under **Secrets and variables -> Actions -> Variables** only if you
want to override the defaults.

- `HF_SPACE_REPO_IDS`: comma-separated Space repo ids to manage.
- `HF_WARMUP_URL`: warmup URL. Defaults to
  `https://ppal-songlab-uga-watermelon-proxy.hf.space/proxy_warmup`.

## Manual Controls

From the GitHub Actions tab, open **Hugging Face Space Schedule** and run it
manually with:

- `status`: print current runtime states.
- `wake`: restart managed Spaces and call warmup.
- `pause`: pause managed Spaces.
- `schedule`: use the current New York time to decide whether to pause, wake, or
  only report status.
