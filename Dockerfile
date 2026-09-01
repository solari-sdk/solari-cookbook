FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --home-dir /app app
COPY requirements.txt requirements-dev.txt* ./
RUN python -m pip install --upgrade pip && python -m pip install -r requirements.txt

COPY app ./app
COPY static-console ./static-console
COPY docs ./docs
RUN mkdir -p /app/data && chown -R app:app /app

USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/v1/ready',timeout=3)); raise SystemExit(0 if d.get('status')=='ready' else 1)"
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
