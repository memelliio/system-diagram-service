import { Hono } from "hono";
import pg from "pg";
import { createClient } from "redis";

const { Client } = pg;
const app = new Hono();

type SpineStatus = "ok" | "warn" | "fail";

const EXPECTED_POOL_HOST = "pgbouncer.railway.internal";
const OWNER_KEY = process.env.OWNER_KEY || "1604";
const SECRET = /(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL|PRIVATE|DSN|URL)/i;
const ENV_HIDE = /^(PATH|HOME|HOSTNAME|PWD|SHLVL|TERM|LANG|LS_COLORS|NODE_|BUN_|npm_|RAILWAY_|NIXPACKS|SSL_CERT|_$)/i;

const ownerGate = async (c: any, next: any) => {
  const authHeader = c.req.header("Authorization") || "";
  const ownerKey = c.req.header("X-Owner-Key") || "";

  if (ownerKey !== OWNER_KEY && !authHeader.includes(OWNER_KEY)) {
    return c.json({ error: "Unauthorized: owner key required" }, 401);
  }

  await next();
};

const safeError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const envValue = (name: string) => process.env[name] || "";

const hostFromValue = (value: string) => {
  if (!value) return "";
  try {
    if (value.startsWith("postgres://") || value.startsWith("postgresql://")) {
      return new URL(value).hostname;
    }
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return new URL(value).hostname;
    }
  } catch {
    return "";
  }
  return value.includes(".railway.internal") ? value.split(":")[0] : "";
};

const mask = (name: string, value = "") => {
  if (!value) return "";
  if (!SECRET.test(name)) return value;
  const host = hostFromValue(value);
  return host ? `***@${host}` : "***";
};

const classifyServiceName = (name: string, value: string) => {
  const clean = name.toLowerCase();
  const host = hostFromValue(value).toLowerCase();
  if (clean.includes("proof") || host.includes("proof")) return "proof";
  if (clean.includes("playwright") || host.includes("playwright")) return "playwright";
  if (clean.includes("livekit") || host.includes("livekit")) return "livekit";
  if (clean.includes("freqtrade") || host.includes("freqtrade")) return "freqtrade";
  if (clean.includes("spawn") || host.includes("spawn")) return "spawn";
  if (clean.includes("pgbouncer") || host.includes("pgbouncer")) return "pgbouncer";
  if (clean.includes("redis") || host.includes("redis")) return "redis";
  if (clean.includes("database") || clean.includes("postgres")) return "database";
  if (clean.includes("memelli") || host.includes("memelli")) return "app";
  return "service";
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const activityAliases = (name: string, type: string) => {
  const base = normalize(name);
  const aliases = new Set([base, normalize(type)]);
  if (type === "app") {
    aliases.add("infinityos");
    aliases.add("nextjs");
  }
  if (type === "proof") {
    aliases.add("proof");
    aliases.add("infinityos");
  }
  if (type === "playwright") aliases.add("playwright");
  if (type === "livekit") aliases.add("livekit");
  if (type === "freqtrade") aliases.add("freqtrade");
  if (type === "spawn") aliases.add("spawn");
  return [...aliases].filter(Boolean);
};

const hasNamedActivity = (activity: any[], name: string, type: string) => {
  const aliases = activityAliases(name, type).filter((alias) => alias.length >= 4);
  if (!aliases.length) return false;
  return activity.some((row) => {
    const appName = normalize(String(row.application_name || ""));
    if (!appName || appName === "unnamed") return false;
    if (appName.includes("systemspinewatchdog")) return false;
    return aliases.some((alias) => appName.includes(alias) || alias.includes(appName));
  });
};

const canShowSpineTraffic = (type: string) => !["pgbouncer", "database", "redis", "livekit"].includes(type);

const healthPathFor = (name: string, url: string) => {
  const type = classifyServiceName(name, url);
  if (type === "app" || type === "proof") return "/api/version";
  if (type === "playwright") return "/health";
  return "/";
};

const withPath = (base: string, path: string) => {
  try {
    const url = new URL(base);
    url.pathname = path;
    url.search = "";
    return url.toString();
  } catch {
    return base;
  }
};

const probe = async (name: string, baseUrl: string) => {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  const path = healthPathFor(name, baseUrl);
  const url = withPath(baseUrl, path);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const status: SpineStatus = res.ok ? "ok" : "warn";
    return {
      name,
      type: classifyServiceName(name, baseUrl),
      target: hostFromValue(baseUrl),
      check: path,
      httpStatus: res.status,
      status,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      name,
      type: classifyServiceName(name, baseUrl),
      target: hostFromValue(baseUrl),
      check: path,
      httpStatus: null,
      status: "fail" as SpineStatus,
      latencyMs: Date.now() - started,
      error: safeError(error),
    };
  }
};

const urlTargets = () => {
  const targets: Array<{ name: string; url: string }> = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || ENV_HIDE.test(name)) continue;
    if (!/^https?:\/\//.test(value)) continue;
    if (SECRET.test(name) && !/(SERVICE|APP|PROOF|PLAYWRIGHT|LIVEKIT|FREQTRADE|URL|ENDPOINT)/i.test(name)) continue;
    targets.push({ name, url: value });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
};

const internalTargets = () => {
  const targets: Array<{ name: string; type: string; target: string; monitoredBy: string }> = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || ENV_HIDE.test(name)) continue;
    const host = hostFromValue(value);
    if (!host || !host.includes(".railway.internal")) continue;
    targets.push({
      name,
      type: classifyServiceName(name, value),
      target: host,
      monitoredBy: value.startsWith("http") ? "http_probe" : "pg_stat_or_env",
    });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
};

const databaseClient = () => {
  const connectionString = envValue("DATABASE_URL");
  if (!connectionString) return null;
  return new Client({
    connectionString,
    ssl: false,
    application_name: "memelli-system-spine-watchdog",
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  } as any);
};

const databaseSnapshot = async () => {
  const host = hostFromValue(envValue("DATABASE_URL"));
  const viaPool = host === EXPECTED_POOL_HOST;
  const client = databaseClient();
  if (!client) {
    return {
      configured: false,
      host,
      viaPool,
      status: "fail" as SpineStatus,
      error: "DATABASE_URL is missing",
      activity: [],
      tables: [],
    };
  }

  try {
    await client.connect();
    const now = await client.query("select now() as now, current_database() as database");
    const activity = await client.query(`
      select
        coalesce(nullif(application_name, ''), 'unnamed') as application_name,
        coalesce(client_addr::text, 'local') as client_addr,
        coalesce(state, 'unknown') as state,
        count(*)::int as count
      from pg_stat_activity
      group by 1,2,3
      order by count desc, application_name asc
      limit 40
    `);
    const tables = await client.query(`
      select name, to_regclass(name) is not null as exists
      from (values
        ('control_store.spawn_nodes'),
        ('control_store.relay_queue'),
        ('control_store.build_queue'),
        ('control_store.render_splats'),
        ('control_store.render_frame_cache'),
        ('control_store.memory_store'),
        ('control_store.memelli_context_documents'),
        ('public.customers'),
        ('public.credit_report_parsed')
      ) as t(name)
    `);

    return {
      configured: true,
      host,
      viaPool,
      status: viaPool ? "ok" as SpineStatus : "fail" as SpineStatus,
      database: now.rows[0]?.database,
      observedAt: now.rows[0]?.now,
      activity: activity.rows,
      tables: tables.rows,
    };
  } catch (error) {
    return {
      configured: true,
      host,
      viaPool,
      status: "fail" as SpineStatus,
      error: safeError(error),
      activity: [],
      tables: [],
    };
  } finally {
    try {
      await client.end();
    } catch {
      // no-op
    }
  }
};

const redisSnapshot = async () => {
  const url = envValue("REDIS_URL");
  const host = hostFromValue(url);
  if (!url) {
    return {
      configured: false,
      host,
      status: "warn" as SpineStatus,
      error: "REDIS_URL is missing",
    };
  }

  const client = createClient({ url, socket: { connectTimeout: 3000 } });
  try {
    await client.connect();
    const pong = await client.ping();
    return {
      configured: true,
      host,
      status: pong === "PONG" ? "ok" as SpineStatus : "warn" as SpineStatus,
      response: pong,
    };
  } catch (error) {
    return {
      configured: true,
      host,
      status: "fail" as SpineStatus,
      error: safeError(error),
    };
  } finally {
    try {
      await client.quit();
    } catch {
      try {
        await client.disconnect();
      } catch {
        // no-op
      }
    }
  }
};

const spineSnapshot = async () => {
  const [db, redis, probes] = await Promise.all([
    databaseSnapshot(),
    redisSnapshot(),
    Promise.all(urlTargets().map((target) => probe(target.name, target.url))),
  ]);

  const violations: Array<{ level: SpineStatus; code: string; message: string }> = [];
  if (!db.viaPool) {
    violations.push({
      level: "fail",
      code: "database_bypass",
      message: `system-diagram DATABASE_URL must route through ${EXPECTED_POOL_HOST}; observed ${db.host || "missing"}`,
    });
  }
  if (db.status === "fail") {
    violations.push({
      level: "fail",
      code: "database_unreachable",
      message: db.error || "Database probe failed",
    });
  }
  if (redis.status === "fail") {
    violations.push({
      level: "fail",
      code: "redis_unreachable",
      message: redis.error || "Redis probe failed",
    });
  }
  for (const item of probes) {
    if (item.status !== "ok") {
      violations.push({
        level: item.status,
        code: "service_probe_not_green",
        message: `${item.name} ${item.check} returned ${item.httpStatus ?? item.error ?? "no response"}`,
      });
    } else if (canShowSpineTraffic(item.type) && !hasNamedActivity(db.activity || [], item.name, item.type)) {
      violations.push({
        level: "warn",
        code: "service_idle_no_spine_activity",
        message: `${item.name} is reachable but has no named pgbouncer activity; idle is a violation until the service emits continuous spine traffic with application_name.`,
      });
    }
  }

  const overall: SpineStatus = violations.some((v) => v.level === "fail")
    ? "fail"
    : violations.some((v) => v.level === "warn")
      ? "warn"
      : "ok";

  return {
    service: "memelli-system-spine-watchdog",
    status: overall,
    expectedPoolHost: EXPECTED_POOL_HOST,
    generatedAt: new Date().toISOString(),
    database: db,
    redis,
    serviceProbes: probes,
    internalTargets: internalTargets(),
    violations,
    env: {
      databaseHost: db.host || "",
      pgbouncerHost: envValue("PGBOUNCER_HOST") || "",
      pgbouncerPort: envValue("PGBOUNCER_PORT") ? "set" : "",
      serviceUrlCount: probes.length,
    },
  };
};

app.get("/health", (c) => {
  const databaseHost = hostFromValue(envValue("DATABASE_URL"));
  return c.json({
    status: "ok",
    type: "memelli-system-spine-watchdog",
    databaseHost,
    viaPool: databaseHost === EXPECTED_POOL_HOST,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/spine", async (c) => c.json(await spineSnapshot()));

app.get("/", (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Memelli Spine Watchdog</title>
  <style>
    :root { color-scheme: dark; --bg:#06070b; --panel:rgba(18,18,22,.86); --line:#26262e; --text:#f5f7fb; --muted:#95a0b5; --ok:#22c55e; --warn:#f59e0b; --fail:#ef4444; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; background: radial-gradient(circle at 20% 10%, rgba(225,29,72,.24), transparent 28%), radial-gradient(circle at 80% 20%, rgba(59,130,246,.18), transparent 25%), var(--bg); color:var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1240px; margin: 0 auto; padding: 28px; }
    header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:22px; }
    h1 { margin:0; font-size:32px; line-height:1.05; }
    p { margin:0; color:var(--muted); }
    .badge { border:1px solid var(--line); border-radius:999px; padding:8px 12px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; font-size:12px; }
    .ok { color:var(--ok); }
    .warn { color:var(--warn); }
    .fail { color:var(--fail); }
    .grid { display:grid; grid-template-columns: repeat(12, 1fr); gap:14px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; box-shadow:0 18px 60px rgba(0,0,0,.32); backdrop-filter: blur(10px); }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    h2 { margin:0 0 12px; font-size:16px; }
    .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid rgba(255,255,255,.06); color:var(--muted); font-size:13px; }
    .row:first-of-type { border-top:0; }
    code { color:#d8e3ff; word-break:break-word; }
    table { width:100%; border-collapse: collapse; font-size:13px; }
    th, td { text-align:left; padding:9px; border-top:1px solid rgba(255,255,255,.07); color:var(--muted); }
    th { color:#d8e3ff; font-size:11px; text-transform:uppercase; letter-spacing:.09em; }
    .dot { width:9px; height:9px; border-radius:999px; display:inline-block; margin-right:8px; background:var(--muted); }
    .dot.ok { background:var(--ok); }
    .dot.warn { background:var(--warn); }
    .dot.fail { background:var(--fail); }
    .muted { color:var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (max-width: 900px) { .span-4,.span-6,.span-8 { grid-column:span 12; } header { flex-direction:column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memelli Spine Watchdog</h1>
        <p>Live pgbouncer, service health, and one-spine violations. This page reads the wire; it is not a static drawing.</p>
      </div>
      <div id="overall" class="badge">loading</div>
    </header>
    <section class="grid">
      <div class="card span-4">
        <h2>Database Spine</h2>
        <div id="db"></div>
      </div>
      <div class="card span-4">
        <h2>Redis State Bus</h2>
        <div id="redis"></div>
      </div>
      <div class="card span-4">
        <h2>Violations</h2>
        <div id="violations"></div>
      </div>
      <div class="card span-12">
        <h2>Service Probes</h2>
        <div id="probes"></div>
      </div>
      <div class="card span-12">
        <h2>Internal Targets</h2>
        <div id="targets"></div>
      </div>
      <div class="card span-6">
        <h2>Postgres Activity</h2>
        <div id="activity"></div>
      </div>
      <div class="card span-6">
        <h2>Runtime Tables</h2>
        <div id="tables"></div>
      </div>
    </section>
  </main>
  <script>
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
    const dot = (s) => '<span class="dot ' + esc(s) + '"></span>';
    const row = (a,b) => '<div class="row"><span>' + esc(a) + '</span><code>' + esc(b) + '</code></div>';
    const table = (heads, rows) => '<table><thead><tr>' + heads.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    const paint = (data) => {
      const overall = document.getElementById('overall');
      overall.className = 'badge ' + data.status;
      overall.textContent = data.status;

      document.getElementById('db').innerHTML =
        row('DATABASE_URL host', data.database.host || 'missing') +
        row('Expected host', data.expectedPoolHost) +
        row('Via pgbouncer', data.database.viaPool ? 'yes' : 'no') +
        row('Database', data.database.database || '-') +
        row('Generated', data.generatedAt);

      document.getElementById('redis').innerHTML =
        row('REDIS_URL host', data.redis.host || 'missing') +
        row('Status', data.redis.status || 'missing') +
        row('Response', data.redis.response || data.redis.error || '-');

      document.getElementById('violations').innerHTML = data.violations.length
        ? data.violations.map(v => '<div class="row"><span>' + dot(v.level) + esc(v.code) + '</span><code>' + esc(v.message) + '</code></div>').join('')
        : '<div class="row"><span>' + dot('ok') + 'no violations</span><code>one-spine checks passed</code></div>';

      document.getElementById('probes').innerHTML = table(['status','name','type','target','check','http','ms'],
        data.serviceProbes.map(p => '<tr><td>' + dot(p.status) + esc(p.status) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.type) + '</td><td class="mono">' + esc(p.target) + '</td><td>' + esc(p.check) + '</td><td>' + esc(p.httpStatus ?? '-') + '</td><td>' + esc(p.latencyMs) + '</td></tr>'));

      document.getElementById('targets').innerHTML = table(['name','type','target','monitor'],
        (data.internalTargets || []).map(t => '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.type) + '</td><td class="mono">' + esc(t.target) + '</td><td>' + esc(t.monitoredBy) + '</td></tr>'));

      document.getElementById('activity').innerHTML = table(['app','client','state','count'],
        (data.database.activity || []).map(a => '<tr><td>' + esc(a.application_name) + '</td><td>' + esc(a.client_addr) + '</td><td>' + esc(a.state) + '</td><td>' + esc(a.count) + '</td></tr>'));

      document.getElementById('tables').innerHTML = table(['table','exists'],
        (data.database.tables || []).map(t => '<tr><td class="mono">' + esc(t.name) + '</td><td>' + (t.exists ? dot('ok') + 'yes' : dot('warn') + 'no') + '</td></tr>'));
    };
    const load = async () => {
      const res = await fetch('/api/spine', { cache: 'no-store' });
      paint(await res.json());
    };
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
  return c.html(html);
});

app.get("/vars", ownerGate, async (c) => {
  try {
    const variables: Record<string, any> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name === "PORT" || ENV_HIDE.test(name)) continue;
      let type = "string";
      if (name === "OWNER_KEY") type = "owner";
      else if (SECRET.test(name)) type = "secret";
      else if (value === "true" || value === "false") type = "boolean";
      variables[name] = { value: mask(name, value), type, host: hostFromValue(value || "") };
    }
    if (!variables.OWNER_KEY) variables.OWNER_KEY = { value: "***", type: "owner" };
    return c.json({ variables, count: Object.keys(variables).length, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("[SYSTEM-WATCHDOG] vars failed:", safeError(error));
    return c.json({ error: "Failed to fetch variables", details: safeError(error) }, 500);
  }
});

app.get("/var/:name", ownerGate, async (c) => {
  const name = c.req.param("name");
  const value = process.env[name];
  if (!value) return c.json({ error: `Variable ${name} not found` }, 404);
  return c.json({
    name,
    value: mask(name, value),
    host: hostFromValue(value),
    type: SECRET.test(name) ? "secret" : "string",
    timestamp: new Date().toISOString(),
  });
});

app.post("/var/:name", ownerGate, async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const value = body?.value;
  if (!value) return c.json({ error: "value required" }, 400);
  console.log(`[SYSTEM-WATCHDOG] owner requested variable update for ${name}; use Railway variable authority to persist it`);
  return c.json({
    name,
    value: mask(name, value),
    status: "not_persisted_here",
    reason: "Railway service variables are the authority; this endpoint does not fake a write.",
    timestamp: new Date().toISOString(),
  }, 202);
});

const port = Number(process.env.PORT) || 3000;
Bun.serve({
  hostname: "::",
  port,
  fetch: app.fetch,
});

console.log(`[SYSTEM-WATCHDOG] Listening on port ${port}`);
