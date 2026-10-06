# siterecon-fetch: reads public social pages and renders a homepage in a headless browser.
# Internal only: publish it on 127.0.0.1 and run it with deploy/vm/run-fetch.sh, which adds the
# resource limits and the read-only filesystem. See docs/DEPLOY.md.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    HOME=/tmp

# git: requirements.txt installs Agent-Reach straight from GitHub.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get purge -y git && apt-get autoremove -y

# HOME is /tmp because the app user has no home directory and the container runs read-only with a
# writable /tmp. Without it Chromium's crash reporter cannot start and the browser dies at launch
# (found by running the real container).
# A user with no shell and no write access to the application.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY app ./app
USER app

EXPOSE 8787
CMD ["uvicorn", "--factory", "app.main:build", "--host", "0.0.0.0", "--port", "8787", "--no-access-log"]
