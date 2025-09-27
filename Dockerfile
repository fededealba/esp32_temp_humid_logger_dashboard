FROM python:3.11-slim

WORKDIR /app

# Copy requirements first for better caching
COPY server/requirements.txt ./server/
RUN pip install --no-cache-dir -r server/requirements.txt

# Copy the rest of the application
COPY server/ ./server/

# Expose port
EXPOSE $PORT

# Change to server directory and run gunicorn
WORKDIR /app/server
CMD gunicorn app:app --bind 0.0.0.0:$PORT