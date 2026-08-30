FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir . \
    && mkdir -p /app/artifacts \
    && chown -R 65532:65532 /app/artifacts

ENV REPO_RESCUE_ARTIFACTS_DIR=/app/artifacts
USER 65532:65532
EXPOSE 8000
CMD ["repo-rescue-mcp"]
