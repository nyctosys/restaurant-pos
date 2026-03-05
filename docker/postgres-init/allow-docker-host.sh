#!/bin/bash
# Allow connections from Docker bridge (host connecting to localhost:5432 appears as 172.18.0.1).
# Only runs on first DB init (e.g. after docker-compose down -v).
echo "host all all 172.16.0.0/12 scram-sha-256" >> /var/lib/postgresql/data/pg_hba.conf
