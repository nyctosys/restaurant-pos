# Use official Python runtime as a parent image
FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install system dependencies required for psycopg2 and other packages
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first to leverage Docker cache
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend application
COPY . .

# Expose port
EXPOSE 5000

# ASGI: FastAPI is the only HTTP surface (Flask is used only for Flask-SQLAlchemy context).
CMD ["uvicorn", "app_fastapi.main:app", "--host", "0.0.0.0", "--port", "5000"]
