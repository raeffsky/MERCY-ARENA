#!/usr/bin/env python3
"""Inject public PostHog browser configuration into the generated static HTML."""
import json
import os
import sys
from pathlib import Path

target = Path(sys.argv[1])
html = target.read_text(encoding="utf-8")
token = os.environ.get("POSTHOG_PROJECT_TOKEN", "").strip()
host = os.environ.get("POSTHOG_API_HOST", "").strip().rstrip("/")

if token and host:
    if not host.startswith("https://"):
        raise SystemExit("POSTHOG_API_HOST must be an HTTPS URL.")
    html = html.replace('"__POSTHOG_PROJECT_TOKEN__"', json.dumps(token))
    html = html.replace('"__POSTHOG_API_HOST__"', json.dumps(host))
    print("PostHog browser analytics configured.")
else:
    html = html.replace('"__POSTHOG_PROJECT_TOKEN__"', '""')
    html = html.replace('"__POSTHOG_API_HOST__"', '""')
    print("PostHog disabled for this build: set POSTHOG_PROJECT_TOKEN and POSTHOG_API_HOST.")

target.write_text(html, encoding="utf-8")
