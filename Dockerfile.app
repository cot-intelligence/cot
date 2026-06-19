# Single self-contained cot image: builds the dashboard and serves it together
# with the collector API from one FastAPI/uvicorn process.
#
#   docker run -d -p 8000:8000 -v ~/.cot:/root/.cot ghcr.io/cot-intelligence/cot
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
FROM python:3.12-slim
WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY bridge ./bridge
COPY --from=web /web/dist ./static

ENV COT_DB_PATH=/root/.cot/cot.db \
    COT_STATIC_DIR=/app/static

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
