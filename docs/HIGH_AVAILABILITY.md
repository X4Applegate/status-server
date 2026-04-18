# High Availability — active/passive failover with MariaDB replication + Cloudflare Load Balancing

This guide walks you through turning a single status-server into a two-node active/passive setup that can survive a full primary outage. The approach:

- **Two hosts** — Primary (writes), Replica (hot standby)
- **MariaDB replication** — Primary streams binlog to Replica; Replica DB mirrors Primary in near real-time
- **Cloudflare Load Balancing** — health-checks both origins, flips traffic on failure
- **Manual promotion** — to avoid split-brain, the Replica must be manually promoted to Primary on failover. A helper script (`scripts/promote-replica.sh`) does this in one command.

Expected behavior:

| Scenario | What happens |
|---|---|
| Primary healthy | Cloudflare sends all traffic to Primary; Replica idles, DB stays in-sync |
| Primary dies | Cloudflare health check fails (~30-60s) → traffic routes to Replica. UI loads in **read-only** mode. Writes (adding servers, new alerts, login) fail until you promote. |
| You run `promote-replica.sh` | Replica DB stops following Primary and becomes writable. App fully functional. |
| Primary comes back | Manual re-bootstrap required (see **After Failover** below). Do NOT just bring it up — you'll split-brain. |

If you want zero-touch automatic failover, you need a proper clustering setup (Galera, Orchestrator, etc.). For most self-hosted monitoring this active/passive approach is the right trade-off — simpler, safer, and a 2-minute manual promotion is acceptable for a monitoring tool.

---

## Part 1 — Enable replication on Primary's MariaDB

Your existing `docker-compose.yml` probably uses an external MariaDB container. Replication requires two changes:

1. **Binary logging** — so changes can be streamed to Replica
2. **A replication user** — Replica authenticates with this

### 1a. Turn on binary logging

Add these MariaDB config lines. The cleanest way is a dedicated conf file mounted into the container:

```yaml
# In the mariadb service of your PRIMARY docker-compose.yml
mariadb:
  image: mariadb:11
  command:
    - --log-bin=mysql-bin
    - --server-id=1
    - --binlog-format=ROW
    - --expire-logs-days=7
    - --binlog-row-image=MINIMAL
  # ...rest unchanged
```

Restart the container:

```bash
docker compose up -d mariadb
```

Verify binlog is on:

```bash
docker exec -it mariadb mariadb -uroot -p -e "SHOW MASTER STATUS;"
# should print a non-empty File + Position row
```

### 1b. Create the replication user

```bash
docker exec -it mariadb mariadb -uroot -p
```

```sql
CREATE USER 'replica'@'%' IDENTIFIED BY 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
GRANT REPLICATION SLAVE ON *.* TO 'replica'@'%';
FLUSH PRIVILEGES;
```

### 1c. Open port 3306 to the Replica's IP only

If Primary's MariaDB is only on the Docker network, you need to expose it so Replica can reach it. **Do not open to `0.0.0.0`** — firewall it to Replica's IP:

```yaml
mariadb:
  ports:
    - "3306:3306"   # only do this if your host firewall allows 3306 ONLY from Replica's IP
```

UFW example on Primary:
```bash
sudo ufw allow from 50.191.208.171 to any port 3306 proto tcp
sudo ufw deny  3306
```

---

## Part 2 — Bootstrap the Replica

On the Replica host (the second box), get a consistent snapshot of Primary's DB and point the Replica's MariaDB at it.

### 2a. Dump Primary's current state

On Primary:
```bash
docker exec mariadb mariadb-dump \
  -uroot -p \
  --all-databases \
  --master-data=2 \
  --single-transaction \
  --quick \
  --triggers --routines --events \
  > /tmp/primary-bootstrap.sql

# Copy to Replica
scp /tmp/primary-bootstrap.sql user@REPLICA_HOST:/tmp/
```

The `--master-data=2` flag embeds a `CHANGE MASTER TO` comment at the top of the dump with the exact binlog coordinates to start replicating from. You'll need those in a moment.

### 2b. Stand up the Replica stack

On Replica, create `/opt/status-server/docker-compose.yml` using the replica example in this repo (`docker-compose.replica.example.yml`). Key differences from Primary:

- `mariadb` command sets `--server-id=2` (must be unique per node) and `--read-only=1`
- `status-server` image is present but you can leave it stopped until failover if you want zero-risk read-only standby (recommended)

```bash
cd /opt/status-server
# Start only MariaDB on Replica for now
docker compose up -d mariadb

# Load the bootstrap dump
docker exec -i mariadb mariadb -uroot -p < /tmp/primary-bootstrap.sql
```

### 2c. Point Replica at Primary

Grab the binlog coordinates from the dump:

```bash
head -30 /tmp/primary-bootstrap.sql | grep "CHANGE MASTER TO"
# -- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1234567;
```

In Replica's MariaDB:

```bash
docker exec -it mariadb mariadb -uroot -p
```

```sql
CHANGE MASTER TO
  MASTER_HOST     = 'PRIMARY_IP',
  MASTER_PORT     = 3306,
  MASTER_USER     = 'replica',
  MASTER_PASSWORD = 'REPLACE_WITH_THE_REPLICATION_PASSWORD',
  MASTER_LOG_FILE = 'mysql-bin.000003',
  MASTER_LOG_POS  = 1234567,
  MASTER_SSL      = 1;

START SLAVE;
SHOW SLAVE STATUS\G
```

You should see:
- `Slave_IO_Running: Yes`
- `Slave_SQL_Running: Yes`
- `Seconds_Behind_Master: 0` (or a small number catching up)

If either `Running` column is `No`, check `Last_IO_Error` / `Last_SQL_Error`.

---

## Part 3 — Cloudflare Load Balancing

Assumes Cloudflare is already your DNS. Load Balancing is a paid add-on (~$5/mo).

1. **Dashboard → Traffic → Load Balancing → Create Load Balancer**
2. **Hostname:** `uptime.richardapplegate.io`
3. **Pool:** create one pool with two origins:
   - Origin 1: `primary` → `50.191.208.169`, weight **1**
   - Origin 2: `replica` → `50.191.208.171`, weight **0** (receives traffic only when Primary is down)
4. **Health monitor:**
   - Type: **HTTPS** (or HTTP if not terminating TLS on origin)
   - Path: `/health`
   - Expected code: **200**
   - Interval: **60s** (or 15s on Pro+)
   - Retries: **2**
   - Timeout: **5s**
5. **Steering:** **Off** — we want simple failover, not geo-steering
6. **Proxy status:** Proxied (orange cloud)

Cloudflare will hit `https://50.191.208.169/health` and `https://50.191.208.171/health` every 60s. When Primary's check fails twice in a row, it stops routing there. When it recovers, it rejoins automatically.

---

## Part 4 — The promotion script (failover)

When Primary is confirmed dead, on Replica run:

```bash
sudo /opt/status-server/scripts/promote-replica.sh
```

See `scripts/promote-replica.sh` in the repo. What it does:

1. `STOP SLAVE;` — stop following Primary
2. `RESET SLAVE ALL;` — forget it was ever a replica
3. `SET GLOBAL read_only = 0;` — allow writes
4. `docker compose up -d status-server` — start the app (if it wasn't already running)

The Replica now serves writes. Cloudflare has already routed traffic to it (from step 3 health-check failure).

---

## Part 5 — After failover: re-bootstrap the old Primary as the new Replica

The old Primary came back. **Do not just start it** — its DB is now out-of-sync with the new Primary (the promoted Replica). You must re-bootstrap:

1. Stop the old Primary's status-server container
2. Treat the new Primary (old Replica) as the source
3. Repeat **Part 2** (dump → copy → load → `CHANGE MASTER TO`) but with the roles reversed
4. When replication is caught up and `Seconds_Behind_Master = 0`, you can either:
   - **Keep the swap** — new Primary stays Primary forever
   - **Fail back** — swap again, a second planned downtime

Most people just keep the swap. Active/passive doesn't care which box is which.

---

## Part 6 — Monitoring the replication itself

Add an HTTP check in status-server for the Replica's `/health` endpoint. That way status-server is monitoring its own standby.

Bonus: write a small script that runs `SHOW SLAVE STATUS` on the Replica and alerts if `Seconds_Behind_Master > 30` or either `Running` column is `No`. You can hook this into status-server as a Script check.

---

## Troubleshooting

**`Slave_IO_Running: No` with `error connecting to master`**
→ Network issue. Check Primary's firewall allows Replica's IP on 3306. Check the replication user's password.

**`Seconds_Behind_Master: NULL`**
→ Replica can't talk to Primary. Usually network/firewall.

**Replica fell way behind, catching up slowly**
→ Normal after large writes. If it's persistent, the Replica box is CPU/IO-starved.

**Split-brain — both boxes got writes**
→ You promoted Replica while Primary was still alive (Cloudflare flipped due to a network glitch, not an actual outage). Recovery: pick one as authoritative, dump it, re-bootstrap the other from scratch.

**The app on Replica is crashing with "Table is read only"**
→ That's working as intended — the Replica's DB is read-only until you promote. Either leave the container stopped, or expect errors until promotion.
