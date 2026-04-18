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
    - --max_allowed_packet=1G        # prevents 1236 errors on large row events
  # ...rest unchanged
```

> **Why `--max_allowed_packet=1G`:** MariaDB's default is 16 MB, but a single binlog event (especially a multi-row INSERT or a large session-store write) can exceed that. When it does, replication fails with:
> `Got fatal error 1236 ... log event entry exceeded max_allowed_packet`.
> Bumping to 1 GB here and on the replica (next section) avoids the problem entirely.

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
- `--max_allowed_packet=1G` and `--slave-max-allowed-packet=1G` to match Primary
- `--replicate-wild-do-table=status_monitor.%` — **important if Primary also hosts other databases** (e.g., another app's DB on the same MariaDB instance). Without this filter, replica receives binlog events for tables it doesn't have and crashes with `Table '<other_db>.<table>' doesn't exist` (error 1146). With it, replica only applies `status_monitor.*` events and silently ignores the rest.
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
  MASTER_HOST                   = 'PRIMARY_IP',
  MASTER_PORT                   = 3306,
  MASTER_USER                   = 'replica',
  MASTER_PASSWORD               = 'REPLACE_WITH_THE_REPLICATION_PASSWORD',
  MASTER_LOG_FILE               = 'mysql-bin.000003',
  MASTER_LOG_POS                = 1234567,
  MASTER_SSL                    = 0,
  MASTER_SSL_VERIFY_SERVER_CERT = 0;

START SLAVE;
SHOW SLAVE STATUS\G
```

> **About SSL:** The default MariaDB container does **not** ship with SSL certs configured. Setting `MASTER_SSL = 1` without certs on the Primary causes replica to read the un-wrapped TCP bytes as if they were TLS, producing the confusing `'bogus data in log event'` error. Leave SSL off unless you've explicitly set up `ssl-ca`/`ssl-cert`/`ssl-key` on Primary. For traffic between your two boxes, either trust the network or put the replication link over a WireGuard/Tailscale tunnel — that's simpler and at least as secure as MariaDB's self-signed TLS.

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
→ Network issue. Check Primary's firewall allows Replica's IP on 3306. Check the replication user's password. Verify from the replica host: `nc -zv PRIMARY_IP 3306` — should say "succeeded."

**`Got fatal error 1236 ... log event entry exceeded max_allowed_packet`**
→ Primary's binlog contains an event bigger than the replica is willing to accept. Fix by setting `--max_allowed_packet=1G` on **both** Primary's compose `command:` and the replica's `command:` (plus `--slave-max-allowed-packet=1G` on replica). A container restart (`docker compose down mariadb && docker compose up -d mariadb`) is required — `SET GLOBAL` at runtime does not affect the existing binlog dump thread.

**`Got fatal error 1236 ... bogus data in log event`**
→ You set `MASTER_SSL = 1` but Primary's MariaDB isn't configured for SSL. Replica is interpreting the un-TLS'd TCP stream as if it were encrypted. Fix with `CHANGE MASTER TO MASTER_SSL = 0, MASTER_SSL_VERIFY_SERVER_CERT = 0;` and restart the slave.

**`Got fatal error 1236 ... Client requested master to start replication from impossible position`**
→ The `MASTER_LOG_FILE` / `MASTER_LOG_POS` you provided don't exist on Primary (probably because Primary rotated its binlog after a restart). Run `SHOW MASTER STATUS;` on Primary *right now* to get the current File + Position, then re-issue `CHANGE MASTER TO` with those values.

**`master and slave have equal MariaDB server ids`**
→ Both nodes are running `--server-id=1`. Make sure Replica's `docker-compose.yml` has `--server-id=2` (or any unique number), then `docker compose down mariadb && docker compose up -d mariadb`. Verify with `SHOW VARIABLES LIKE 'server_id';` — **must** print 2 on Replica.

**`Last_SQL_Error: Table '<other_db>.<table>' doesn't exist` (error 1146)**
→ Primary hosts multiple databases on the same MariaDB instance. Your bootstrap dump only loaded `status_monitor`, but replica is receiving binlog events for the other DBs too. Fix: add `--replicate-wild-do-table=status_monitor.%` to Replica's `command:` block, restart, `RESET SLAVE;` and re-run `CHANGE MASTER TO` with fresh coordinates.

**`Seconds_Behind_Master: NULL`**
→ Replica can't talk to Primary. Usually network/firewall. Also printed when the SQL thread has crashed — check `Last_SQL_Error`.

**Replica fell way behind, catching up slowly**
→ Normal after large writes. If it's persistent, the Replica box is CPU/IO-starved.

**Split-brain — both boxes got writes**
→ You promoted Replica while Primary was still alive (Cloudflare flipped due to a network glitch, not an actual outage). Recovery: pick one as authoritative, dump it, re-bootstrap the other from scratch.

**The app on Replica is crashing with "Table is read only"**
→ That's working as intended — the Replica's DB is read-only until you promote. Either leave the container stopped (recommended — the provided `docker-compose.replica.example.yml` gates it behind the `promoted` profile), or expect errors until promotion.
