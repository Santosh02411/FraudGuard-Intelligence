FROM python:3.11-slim

WORKDIR /app

# matplotlib/scikit-learn/xgboost need a few system libs beyond the slim
# base image; kept minimal on purpose.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The pre-trained model registry (models/registry/, current_version.json)
# ships IN the image — app.py loads whichever version is currently
# promoted at startup, no training step needed to run the service. See
# train_model.py / retrain_pipeline.py for producing a new version.
COPY . .

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health', timeout=3)" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
