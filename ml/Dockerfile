# The Python ML service. The model is trained while the image is built, from
# the synthetic data in data/tickets.csv, so the image always carries a model
# that matches its code. Built from ml/: docker build ml
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# Runtime packages only (the test packages in requirements.txt are not needed).
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn>=0.30" "scikit-learn>=1.5" "joblib>=1.4"
COPY model.py service.py train.py ./
COPY data/ data/
RUN python train.py
RUN useradd --create-home ml
USER ml
EXPOSE 8001
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8001"]
