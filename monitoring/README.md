# Raahi Backend Monitoring Stack

Production-grade monitoring using Prometheus, Grafana, and exporters.

## Components

| Service | Port | Purpose |
|---------|------|---------|
| Prometheus | 9090 | Metrics collection & alerting |
| Grafana | 3001 | Visualization dashboards |
| Alertmanager | 9093 | Alert routing & management |
| Node Exporter | - | System metrics (CPU, Memory, Disk) |
| Postgres Exporter | - | PostgreSQL metrics |
| Redis Exporter | - | Redis metrics |
| Blackbox Exporter | - | HTTP endpoint probing |
| cAdvisor | - | Docker container metrics |

## Quick Start

### 1. Deploy the Stack

```bash
# On your server
cd /opt/raahi-backend
git pull origin main

# Start all services including monitoring
docker-compose -f docker-compose.prod.yml up -d

# Verify monitoring services are running
docker-compose -f docker-compose.prod.yml ps | grep -E "prometheus|grafana|exporter|cadvisor|alertmanager"
```

### 2. Access Dashboards

| Service | URL | Credentials |
|---------|-----|-------------|
| Grafana | http://YOUR_SERVER_IP:3001 | admin / raahi_grafana_2024 |
| Prometheus | http://YOUR_SERVER_IP:9090 | No auth |
| Alertmanager | http://YOUR_SERVER_IP:9093 | No auth |

### 3. Default Grafana Dashboards

Three dashboards are auto-provisioned:

1. **Infrastructure Dashboard** - System metrics (CPU, Memory, Disk, Network)
2. **Services Dashboard** - Service health, response times, container metrics
3. **Database Dashboard** - PostgreSQL & Redis metrics

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Grafana
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=your_secure_password_here
GRAFANA_ROOT_URL=http://your-domain.com:3001

# Already existing (used by postgres-exporter)
POSTGRES_PASSWORD=your_postgres_password
```

### Prometheus Targets

Prometheus scrapes:
- All service `/health` endpoints via blackbox exporter
- Node metrics via node-exporter
- PostgreSQL metrics via postgres-exporter
- Redis metrics via redis-exporter
- Container metrics via cAdvisor

### Alert Rules

Pre-configured alerts in `monitoring/prometheus/alert.rules.yml`:

| Alert | Condition | Severity |
|-------|-----------|----------|
| ServiceDown | Service unreachable for 1m | Critical |
| HighErrorRate | 5xx rate > 5% for 2m | Warning |
| HighCPUUsage | CPU > 80% for 5m | Warning |
| HighMemoryUsage | Memory > 85% for 5m | Warning |
| DiskSpaceLow | Disk < 15% for 5m | Warning |
| DiskSpaceCritical | Disk < 5% for 1m | Critical |
| PostgreSQLDown | DB unreachable for 1m | Critical |
| PostgreSQLConnectionsHigh | Connections > 80 | Warning |
| RedisDown | Redis unreachable for 1m | Critical |
| ContainerRestarting | Container restarts > 2 in 5m | Warning |

## Useful Commands

### Check Prometheus Targets

```bash
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'
```

### Reload Prometheus Config

```bash
curl -X POST http://localhost:9090/-/reload
```

### Query Metrics via CLI

```bash
# CPU usage
curl -s 'http://localhost:9090/api/v1/query?query=100-avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100'

# Memory usage
curl -s 'http://localhost:9090/api/v1/query?query=(1-(node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes))*100'

# Service health
curl -s 'http://localhost:9090/api/v1/query?query=probe_success'
```

### View Active Alerts

```bash
curl -s http://localhost:9093/api/v2/alerts | jq '.[].labels.alertname'
```

## File Structure

```
monitoring/
├── prometheus/
│   ├── prometheus.yml      # Prometheus configuration
│   └── alert.rules.yml     # Alert rules
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/
│   │   │   └── datasource.yml
│   │   └── dashboards/
│   │       └── dashboard.yml
│   └── dashboards/
│       ├── infrastructure.json
│       ├── services.json
│       └── database.json
├── alertmanager/
│   └── alertmanager.yml    # Alertmanager configuration
├── blackbox/
│   └── blackbox.yml        # Blackbox exporter modules
└── README.md               # This file
```

## Troubleshooting

### Prometheus not scraping targets

```bash
# Check Prometheus logs
docker logs raahi-prometheus --tail=50

# Verify config syntax
docker exec raahi-prometheus promtool check config /etc/prometheus/prometheus.yml
```

### Grafana dashboards not loading

```bash
# Check Grafana logs
docker logs raahi-grafana --tail=50

# Verify provisioning files
docker exec raahi-grafana ls -la /etc/grafana/provisioning/
```

### Exporters not connecting

```bash
# Check exporter logs
docker logs raahi-postgres-exporter --tail=20
docker logs raahi-redis-exporter --tail=20
docker logs raahi-node-exporter --tail=20
```

### Reset Grafana Admin Password

```bash
docker exec -it raahi-grafana grafana-cli admin reset-admin-password new_password
```

## Security Notes

1. **Change default passwords** before production deployment
2. **Restrict port access** - Consider using nginx proxy with auth for Prometheus/Alertmanager
3. **Use HTTPS** for Grafana in production
4. Grafana ports (3001) and Prometheus (9090) are exposed - secure with firewall rules

## Data Persistence

All monitoring data is persisted in Docker volumes:
- `prometheus_data` - Prometheus time-series data (15 days retention)
- `grafana_data` - Grafana dashboards, users, settings
- `alertmanager_data` - Alertmanager state

To backup:
```bash
docker run --rm -v raahi-backend_prometheus_data:/data -v $(pwd):/backup alpine tar czf /backup/prometheus_backup.tar.gz /data
```
