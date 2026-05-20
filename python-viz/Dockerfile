FROM python:3.11-slim

WORKDIR /app

# System libs required by RDKit and Cairo
RUN apt-get update && apt-get install -y \
    libxrender1 \
    libxext6 \
    libglib2.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
