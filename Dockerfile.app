# Single self-contained cot image: builds the dashboard and serves it together
# with the collector API from one FastAPI/uvicorn process.
#
#   docker run -d -p 8000:8000 --read-only --cap-drop ALL \
#     --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
#     --user "$(id -u):$(id -g)" -v ~/.cot:/data ghcr.io/cot-intelligence/cot
#
# Then open http://localhost:8000 and point your agent hooks at it.

# --- Stage 1: build the dashboard ---
FROM node:22-alpine AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci || npm install
COPY . .
RUN npm run build

# --- Stage 2: backend + bundled dashboard ---
FROM python:3.12-alpine
WORKDIR /app

ARG COT_UID=10001
ARG COT_GID=10001

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/home/cot \
    COT_DB_PATH=/data/cot.db \
    COT_STATIC_DIR=/app/static

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir --no-compile -r requirements.txt \
    && find /usr/local -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find /usr/local/lib/python3.12 -type d \( -name test -o -name tests \) -prune -exec rm -rf {} + \
    && rm -rf \
      /root/.cache \
      /usr/local/bin/pip* \
      /usr/local/lib/python3.12/ensurepip \
      /usr/local/lib/python3.12/idlelib \
      /usr/local/lib/python3.12/tkinter \
      /usr/local/lib/python3.12/turtledemo \
      /usr/local/lib/python3.12/site-packages/pip* \
      /usr/local/lib/python3.12/site-packages/setuptools* \
      /usr/local/lib/python3.12/site-packages/wheel* \
    && addgroup -g "${COT_GID}" -S cot \
    && adduser -u "${COT_UID}" -S -D -H -G cot -s /sbin/nologin cot \
    && install -d -o cot -g cot -m 0755 /app \
    && install -d -o cot -g cot -m 0750 /data /home/cot \
    && rm -f /bin/sh /bin/ash /bin/busybox

COPY --chown=cot:cot backend/app ./app
COPY --chown=cot:cot bridge ./bridge
COPY --chown=cot:cot --from=web /web/dist ./static

EXPOSE 8000
USER cot:cot
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).read()"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
