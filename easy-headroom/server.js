const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

// Row-level store, not a pre-aggregated-per-hostname snapshot: each client (one per RTK
// install, identified by a random instance_id — see vscode/src/rtkSyncState.ts, not by
// hostname/username, both of which collide in practice across shared hosts and multiple
// workspaces on one machine) pushes its raw `commands` rows incrementally, keyed on
// (instance_id, id) so re-pushing after a lost/reset local checkpoint is a harmless no-op
// instead of double-counting.
const DB_PATH = '/data/rtk/aggregate.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS commands (
    instance_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    id_project TEXT NOT NULL,
    timestamp TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    saved_tokens INTEGER NOT NULL DEFAULT 0,
    savings_pct REAL NOT NULL DEFAULT 0,
    exec_time_ms INTEGER NOT NULL DEFAULT 0,
    project_path TEXT,
    PRIMARY KEY (instance_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_commands_project ON commands(id_project);
  CREATE INDEX IF NOT EXISTS idx_commands_instance ON commands(instance_id);
`);

// Gates /rtk/* against end users, using the same header Headroom's own proxy natively accepts
// (X-Headroom-Proxy-Token) — so callers use one convention for both. Empty/unset => no auth at
// all (convenient for local/dev). NOT used to authenticate this service to easy-headroom-proxy
// anymore: that header is forwarded through untouched from whatever the client sent (see
// headroomProxy below), never injected here, so it never collides with the client's own
// Authorization/x-api-key headers carrying their real Anthropic credentials.
const PROXY_TOKEN = process.env.HEADROOM_PROXY_TOKEN || '';
if (!PROXY_TOKEN) console.warn('HEADROOM_PROXY_TOKEN not set — /rtk/* is unprotected');

function requireApiKey(req, res, next) {
  if (!PROXY_TOKEN) return next();
  if (req.get('X-Headroom-Proxy-Token') !== PROXY_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function projectFilter(project) {
  return project ? { where: 'WHERE id_project = ?', params: [project] } : { where: '', params: [] };
}

function withDerived(rows) {
  return rows.map((r) => ({
    ...r,
    savings_pct: r.input_tokens + r.output_tokens > 0
      ? (r.saved_tokens / (r.input_tokens + r.output_tokens)) * 100 : 0,
    avg_time_ms: r.commands ? r.total_time_ms / r.commands : 0,
  }));
}

function computeSummary(project) {
  const { where, params } = projectFilter(project);
  const row = db.prepare(`
    SELECT COUNT(*) AS total_commands,
           COALESCE(SUM(input_tokens), 0) AS total_input,
           COALESCE(SUM(output_tokens), 0) AS total_output,
           COALESCE(SUM(saved_tokens), 0) AS total_saved,
           COALESCE(SUM(exec_time_ms), 0) AS total_time_ms
    FROM commands ${where}
  `).get(...params);
  const denom = row.total_input + row.total_output;
  return {
    ...row,
    avg_savings_pct: denom > 0 ? (row.total_saved / denom) * 100 : 0,
    avg_time_ms: row.total_commands > 0 ? row.total_time_ms / row.total_commands : 0,
  };
}

function computeDaily(project) {
  const { where, params } = projectFilter(project);
  const rows = db.prepare(`
    SELECT date(timestamp) AS date,
           COUNT(*) AS commands,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(saved_tokens), 0) AS saved_tokens,
           COALESCE(SUM(exec_time_ms), 0) AS total_time_ms
    FROM commands ${where}
    GROUP BY date
    ORDER BY date ASC
  `).all(...params);
  return withDerived(rows);
}

// SQLite has no canonical ISO week-boundary function — %Y-%W buckets by a Sunday-start week
// number, not a true ISO week, and week_start/week_end are the min/max *observed* command dates
// within that bucket rather than the calendar week's actual boundaries. Fine for a rough trend
// view; not exact for e.g. billing-period reporting.
function computeWeekly(project) {
  const { where, params } = projectFilter(project);
  const rows = db.prepare(`
    SELECT strftime('%Y-%W', timestamp) AS week,
           MIN(date(timestamp)) AS week_start,
           MAX(date(timestamp)) AS week_end,
           COUNT(*) AS commands,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(saved_tokens), 0) AS saved_tokens,
           COALESCE(SUM(exec_time_ms), 0) AS total_time_ms
    FROM commands ${where}
    GROUP BY week
    ORDER BY week ASC
  `).all(...params);
  return withDerived(rows).map(({ week, ...rest }) => rest);
}

function computeMonthly(project) {
  const { where, params } = projectFilter(project);
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', timestamp) AS month,
           COUNT(*) AS commands,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(saved_tokens), 0) AS saved_tokens,
           COALESCE(SUM(exec_time_ms), 0) AS total_time_ms
    FROM commands ${where}
    GROUP BY month
    ORDER BY month ASC
  `).all(...params);
  return withDerived(rows);
}

function aggregate(project) {
  return {
    summary: computeSummary(project),
    daily: computeDaily(project),
    weekly: computeWeekly(project),
    monthly: computeMonthly(project),
  };
}

// Deliberately no original_cmd/rtk_cmd columns: the client (rtkDb.ts) never reads or sends
// actual shell command text, only stats — see the "never transmit shell command content" rule
// in vscode/CLAUDE.md, the same boundary rtk gain's own summary output already respected.
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO commands
    (instance_id, id, id_project, timestamp, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path)
  VALUES
    (@instance_id, @id, @id_project, @timestamp, @input_tokens, @output_tokens, @saved_tokens, @savings_pct, @exec_time_ms, @project_path)
`);
const insertRows = db.transaction((instanceId, idProject, rows) => {
  for (const row of rows) {
    insertStmt.run({
      instance_id: instanceId,
      id: row.id,
      id_project: idProject,
      timestamp: row.timestamp ?? null,
      input_tokens: row.input_tokens ?? 0,
      output_tokens: row.output_tokens ?? 0,
      saved_tokens: row.saved_tokens ?? 0,
      savings_pct: row.savings_pct ?? 0,
      exec_time_ms: row.exec_time_ms ?? 0,
      project_path: row.project_path ?? null,
    });
  }
});

// express.json() is scoped to the /rtk router: the rest of the traffic (proxied to
// Headroom, potentially large API payloads) must never have its body consumed here.
const rtk = express.Router();
rtk.use(express.json({ limit: '5mb' }));

// Raw per-command rows straight from the client's RTK SQLite DB (see
// vscode/src/rtkReporting.ts), not `rtk gain`'s pre-aggregated summary — richer data (per-row
// project attribution, timestamps) than the CLI's own summary output exposes.
rtk.post('/ingest', requireApiKey, (req, res) => {
  const { instance_id, id_project, rows } = req.body;
  if (!instance_id || !id_project || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'bad payload' });
  }
  insertRows(instance_id, id_project, rows);
  res.json({ ok: true });
});

// Lets a client reconcile its local push checkpoint against what this server actually holds
// for that instance_id — used at startup so a lost/reset local checkpoint file resumes from
// the server's real state instead of re-pushing (harmlessly, but wastefully) from scratch.
rtk.get('/checkpoint', requireApiKey, (req, res) => {
  const instanceId = req.query.instance_id;
  if (!instanceId) return res.status(400).json({ error: 'instance_id required' });
  const row = db.prepare('SELECT MAX(id) AS last_id FROM commands WHERE instance_id = ?').get(instanceId);
  res.json({ last_id: row.last_id ?? 0 });
});

// This is what the rtk wrapper (mounted in the headroom container) calls. Optional
// ?project=<id_project> scopes every field to one project instead of all of them.
rtk.get('/aggregate', requireApiKey, (req, res) => res.json(aggregate(req.query.project)));

// Backs the RTK dashboard tab's project picker and its "all projects" breakdown table
// (see vscode/CLAUDE.md) — full per-project sums, not just a count, so the client doesn't need
// N extra /rtk/aggregate?project=... calls to render that table.
rtk.get('/projects', requireApiKey, (req, res) => {
  const rows = db.prepare(`
    SELECT id_project,
           COUNT(*) AS commands,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(saved_tokens), 0) AS saved_tokens
    FROM commands
    GROUP BY id_project
    ORDER BY commands DESC
  `).all();
  const projects = rows.map((r) => ({
    ...r,
    avg_savings_pct: r.input_tokens + r.output_tokens > 0
      ? (r.saved_tokens / (r.input_tokens + r.output_tokens)) * 100 : 0,
  }));
  res.json({ projects });
});

app.use('/rtk', rtk);

// Everything else (dashboard, proxied Anthropic API, etc.): only this service is
// publicly exposed, easy-headroom-proxy stays on the internal Docker network (see docker-compose.yml).
const HEADROOM_TARGET = process.env.HEADROOM_TARGET || 'http://easy-headroom-proxy:8787';
const headroomProxy = createProxyMiddleware({
  target: HEADROOM_TARGET,
  changeOrigin: true,
  ws: true,
  on: {
    // No header injection here, ever: every header (Authorization/x-api-key with the client's
    // real Anthropic credentials, or X-Headroom-Proxy-Token for Headroom's own gate) is forwarded
    // through exactly as the client sent it. Callers are responsible for their own
    // X-Headroom-Proxy-Token — Claude Code via ANTHROPIC_CUSTOM_HEADERS (vscode/src/daemon.ts) for
    // API traffic, the VS Code extension's own local dashboard proxy (startDashboardProxy in
    // commands.ts) for /dashboard, since a plain browser hitting this URL directly can't attach
    // one itself (and won't be authenticated — that's expected, not a bug).
    // Headroom sends X-Frame-Options: DENY on /dashboard, which blocks embedding it in an
    // iframe/webview from a remote (headroom.mode=remote) client — same issue already fixed
    // client-side in the VS Code extension's local dashboard proxy (commands.ts).
    proxyRes: (proxyRes) => {
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['content-security-policy-report-only'];
    },
  },
});
app.use(headroomProxy);

const PORT = process.env.PORT || 8787;
const server = app.listen(PORT, () =>
  console.log(`easy-headroom listening on ${PORT} (proxying to ${HEADROOM_TARGET})`)
);
// http-proxy-middleware doesn't catch WebSocket upgrades via app.use alone with Express —
// it must be wired explicitly to the underlying HTTP server.
server.on('upgrade', headroomProxy.upgrade);
