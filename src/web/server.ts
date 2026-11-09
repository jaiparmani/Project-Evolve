import express from "express";
import cors from "cors";
import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { apiRouter } from "../api/routes.js";
import { resolve } from "path";
import { readFileSync } from "fs";

const log = childLogger("server");
const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", apiRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/{*path}", (_req, res) => {
  res.type("html").send(getDashboardHtml());
});

app.listen(config.server.port, () => {
  log.info("Control Room running at http://localhost:%d", config.server.port);
});

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Evolve — Control Room</title>
  <style>
    :root {
      --bg: #0a0b0e;
      --surface: #111318;
      --surface-2: #16181f;
      --surface-3: #1c1f28;
      --border: rgba(255,255,255,0.06);
      --border-2: rgba(255,255,255,0.1);
      --text: #d4d7e0;
      --text-2: #7c8294;
      --text-3: #4e5364;
      --accent: #5ee0c8;
      --accent-dim: rgba(94,224,200,0.1);
      --amber: #e9a830;
      --rose: #ef5f7b;
      --good: #4ade80;
      --blue: #60a5fa;
      --mono: ui-monospace, "SF Mono", Menlo, monospace;
      --sans: system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; }
    body { background: var(--bg); color: var(--text); font: 13px/1.5 var(--mono); -webkit-font-smoothing: antialiased; min-height: 100vh; }
    a { color: var(--accent); text-decoration: none; }

    .topbar {
      position: sticky; top: 0; z-index: 10;
      background: var(--surface); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; padding: 0 20px; height: 48px; gap: 8px;
    }
    .topbar .logo { font: 600 14px/1 var(--sans); color: var(--accent); letter-spacing: -0.02em; }
    .topbar .logo span { color: var(--text-3); font-weight: 400; margin-left: 8px; font-size: 11px; }
    .topbar nav { display: flex; gap: 2px; margin-left: 24px; }
    .topbar nav button {
      padding: 6px 14px; border-radius: 6px; font: 500 12px/1.4 var(--sans);
      color: var(--text-2); background: none; border: none; cursor: pointer;
    }
    .topbar nav button:hover { background: var(--surface-2); color: var(--text); }
    .topbar nav button.active { background: var(--accent-dim); color: var(--accent); }
    .topbar .actions { margin-left: auto; display: flex; gap: 6px; }
    .topbar .actions button {
      padding: 6px 12px; border-radius: 6px; font: 500 11px/1 var(--sans);
      background: var(--accent); color: var(--bg); border: none; cursor: pointer;
    }
    .topbar .actions button:hover { opacity: 0.9; }
    .topbar .actions button:disabled { opacity: 0.4; cursor: not-allowed; }

    .main { max-width: 1400px; margin: 0 auto; padding: 20px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 20px; }

    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 16px;
    }
    .card-header {
      font: 600 9px/1 var(--sans); letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--text-3); margin-bottom: 12px; display: flex; align-items: center; gap: 6px;
    }
    .card-header .dot {
      width: 6px; height: 6px; border-radius: 50%; display: inline-block;
    }
    .card-header .dot.green { background: var(--good); }
    .card-header .dot.amber { background: var(--amber); }
    .card-header .dot.red { background: var(--rose); }
    .card-header .dot.blue { background: var(--blue); }

    .stat { font: 600 28px/1 var(--sans); color: var(--text); margin-bottom: 4px; }
    .stat-label { font-size: 11px; color: var(--text-2); }
    .stat-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .stat-row:last-child { border-bottom: none; }

    .phase-pipeline {
      display: flex; gap: 4px; align-items: center; padding: 12px 0; flex-wrap: wrap;
    }
    .phase {
      padding: 4px 10px; border-radius: 4px; font: 500 10px/1.4 var(--sans);
      background: var(--surface-2); color: var(--text-3);
    }
    .phase.active { background: var(--accent-dim); color: var(--accent); animation: pulse 2s infinite; }
    .phase.done { background: rgba(74,222,128,0.1); color: var(--good); }
    .phase.failed { background: rgba(239,95,123,0.1); color: var(--rose); }
    .phase-arrow { color: var(--text-3); font-size: 10px; }

    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }

    .timeline { list-style: none; padding: 0; }
    .timeline-item {
      padding: 12px 0; border-bottom: 1px solid var(--border);
      display: grid; grid-template-columns: 1fr auto; gap: 8px;
    }
    .timeline-item:last-child { border-bottom: none; }
    .timeline-title { font: 500 12px/1.4 var(--sans); color: var(--text); }
    .timeline-meta { font-size: 11px; color: var(--text-2); }
    .timeline-status { font: 500 10px/1 var(--sans); padding: 3px 8px; border-radius: 4px; align-self: start; }
    .timeline-status.completed { background: rgba(74,222,128,0.1); color: var(--good); }
    .timeline-status.failed { background: rgba(239,95,123,0.1); color: var(--rose); }
    .timeline-status.rejected { background: rgba(233,168,48,0.1); color: var(--amber); }
    .timeline-status.running { background: var(--accent-dim); color: var(--accent); }

    .tab-bar { display: flex; gap: 2px; margin-bottom: 16px; }
    .tab-bar button {
      padding: 8px 16px; border-radius: 6px 6px 0 0; font: 500 12px/1.4 var(--sans);
      color: var(--text-2); background: none; border: none; cursor: pointer;
      border-bottom: 2px solid transparent;
    }
    .tab-bar button.active { color: var(--accent); border-bottom-color: var(--accent); }

    .empty { text-align: center; padding: 40px; color: var(--text-3); }
    .empty p { font-size: 12px; margin-top: 8px; }

    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; font: 500 10px/1.4 var(--sans); }
    .badge.green { background: rgba(74,222,128,0.1); color: var(--good); }
    .badge.amber { background: rgba(233,168,48,0.1); color: var(--amber); }
    .badge.red { background: rgba(239,95,123,0.1); color: var(--rose); }
    .badge.blue { background: rgba(96,165,250,0.1); color: var(--blue); }

    .version-viewer { display: grid; grid-template-columns: 240px 1fr; gap: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; min-height: 500px; }
    .version-sidebar { background: var(--surface-2); border-right: 1px solid var(--border); overflow-y: auto; max-height: 70vh; }
    .version-sidebar .file-item {
      padding: 8px 12px; font-size: 11px; cursor: pointer; border-bottom: 1px solid var(--border);
      color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .version-sidebar .file-item:hover { background: var(--surface-3); color: var(--text); }
    .version-sidebar .file-item.active { background: var(--accent-dim); color: var(--accent); }
    .version-code { background: var(--surface); overflow: auto; max-height: 70vh; padding: 0; }
    .version-code pre { margin: 0; padding: 16px; font-size: 11px; line-height: 1.6; white-space: pre; }
    .version-code .line-num { display: inline-block; width: 40px; color: var(--text-3); text-align: right; margin-right: 12px; user-select: none; }
    .version-header { padding: 10px 16px; border-bottom: 1px solid var(--border); font: 500 11px/1.4 var(--sans); color: var(--text-2); background: var(--surface-2); }

    .timeline-versions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
    .version-card {
      padding: 12px 16px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border);
      cursor: pointer; min-width: 140px; transition: border-color 0.2s;
    }
    .version-card:hover { border-color: var(--accent); }
    .version-card.active { border-color: var(--accent); background: var(--accent-dim); }
    .version-card .v-num { font: 600 14px/1.4 var(--sans); color: var(--text); }
    .version-card .v-meta { font-size: 10px; color: var(--text-2); margin-top: 2px; }
    .version-card .v-cycle { font-size: 10px; color: var(--text-3); }

    .version-iframe-wrap { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-top: 16px; }
    .version-iframe-wrap iframe { width: 100%; height: 500px; border: none; background: #fff; }
    .version-tabs { display: flex; gap: 2px; margin-top: 16px; margin-bottom: 0; }
    .version-tabs button {
      padding: 6px 14px; border-radius: 6px 6px 0 0; font: 500 11px/1.4 var(--sans);
      color: var(--text-2); background: none; border: none; cursor: pointer;
      border-bottom: 2px solid transparent;
    }
    .version-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }

    #loading { display: flex; align-items: center; justify-content: center; height: 60vh; }
    #loading .spinner { width: 24px; height: 24px; border: 2px solid var(--border-2); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .detail-modal {
      position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100;
      display: none; align-items: center; justify-content: center;
    }
    .detail-modal.open { display: flex; }
    .detail-content {
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      width: 90%; max-width: 800px; max-height: 80vh; overflow-y: auto; padding: 24px;
    }
    .detail-close {
      float: right; background: none; border: none; color: var(--text-2);
      cursor: pointer; font-size: 18px; padding: 4px;
    }
    .detail-section { margin-top: 16px; }
    .detail-section h3 { font: 600 11px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-3); margin-bottom: 8px; }
    pre { background: var(--surface-2); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 11px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">Project Evolve <span>Control Room</span></div>
    <nav>
      <button class="active" data-tab="overview">Overview</button>
      <button data-tab="timeline">Timeline</button>
      <button data-tab="history">History</button>
      <button data-tab="ideas">Ideas</button>
      <button data-tab="usage">Usage</button>
      <button data-tab="config">Config</button>
    </nav>
    <div class="actions">
      <button id="evolveBtn" onclick="triggerEvolve()">Evolve Now</button>
    </div>
  </div>

  <div class="main">
    <div id="loading"><div class="spinner"></div></div>
    <div id="content" style="display:none">
      <div id="tab-overview"></div>
      <div id="tab-timeline" style="display:none"></div>
      <div id="tab-history" style="display:none"></div>
      <div id="tab-ideas" style="display:none"></div>
      <div id="tab-usage" style="display:none"></div>
      <div id="tab-config" style="display:none"></div>
    </div>
  </div>

  <div class="detail-modal" id="detailModal">
    <div class="detail-content" id="detailContent">
      <button class="detail-close" onclick="closeDetail()">&times;</button>
      <div id="detailBody"></div>
    </div>
  </div>

  <script>
    let state = { status: null, cycles: [], ideas: [], usage: null, configs: [] };
    let currentTab = 'overview';
    let refreshInterval;

    function toSnake(str) { return str.replace(/([A-Z])/g, '_$1').toLowerCase(); }
    function snakeKeys(obj) {
      if (Array.isArray(obj)) return obj.map(snakeKeys);
      if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[toSnake(k)] = snakeKeys(v);
        return out;
      }
      return obj;
    }

    async function fetchApi(path) {
      const res = await fetch('/api' + path);
      return snakeKeys(await res.json());
    }

    async function loadData() {
      try {
        const [status, cycles, ideas, usage, configs] = await Promise.all([
          fetchApi('/status'),
          fetchApi('/cycles?limit=20'),
          fetchApi('/ideas'),
          fetchApi('/usage'),
          fetchApi('/config'),
        ]);
        state = { status, cycles: cycles.cycles, ideas, usage, configs };
        render();
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
      } catch (e) {
        console.error('Failed to load:', e);
      }
    }

    function render() {
      renderOverview();
      if (currentTab === 'timeline' && !activeVersionCycleId) renderTimeline();
      renderHistory();
      renderIdeas();
      renderUsage();
      renderConfig();
    }

    function renderOverview() {
      const s = state.status;
      if (!s) return;
      const p = s.project || {};
      const w = s.worker || {};
      const d = s.deploy || {};

      const runningCycle = state.cycles.find(c => c.status === 'running');
      const phases = ['observing','strategizing','planning','building','evaluating','committing','deploying','learning'];

      document.getElementById('tab-overview').innerHTML = \`
        <div class="grid">
          <div class="card">
            <div class="card-header"><span class="dot green"></span> APPLICATION</div>
            <div class="stat">\${p.name || 'Not configured'}</div>
            <div class="stat-label">Version \${p.current_version || '0.0.0'} · Quality \${p.quality_score || 0}/100</div>
          </div>
          <div class="card">
            <div class="card-header"><span class="dot \${w.isRunning ? 'amber' : 'green'}"></span> EVOLUTION ENGINE</div>
            <div class="stat">\${w.isRunning ? 'Running' : 'Idle'}</div>
            <div class="stat-label">\${s.todayCycles || 0} cycles today · Every \${w.intervalMinutes || 30}min</div>
          </div>
          <div class="card">
            <div class="card-header"><span class="dot \${d.running ? 'green' : 'red'}"></span> DEPLOYMENT</div>
            <div class="stat">\${d.running ? 'Live' : 'Stopped'}</div>
            <div class="stat-label">\${d.url || 'No deployment'}</div>
          </div>
          <div class="card">
            <div class="card-header"><span class="dot blue"></span> EVOLUTION STATS</div>
            <div class="stat">\${p.total_cycles || 0}</div>
            <div class="stat-label">\${p.successful_cycles || 0} successful · \${p.failed_cycles || 0} failed</div>
          </div>
        </div>

        \${runningCycle ? \`
        <div class="card" style="margin-bottom:20px">
          <div class="card-header"><span class="dot amber"></span> LIVE ACTIVITY</div>
          <div style="font:500 12px/1.4 var(--sans);color:var(--text);margin-bottom:8px">
            Cycle #\${runningCycle.cycle_number}: \${runningCycle.selected_improvement || 'Analyzing...'}
          </div>
          <div class="phase-pipeline">
            \${phases.map(ph => {
              const status = runningCycle.phase === ph ? 'active' :
                phases.indexOf(ph) < phases.indexOf(runningCycle.phase) ? 'done' : '';
              return \`<span class="phase \${status}">\${ph}</span><span class="phase-arrow">→</span>\`;
            }).join('')}
            <span class="phase \${runningCycle.status === 'completed' ? 'done' : ''}">complete</span>
          </div>
        </div>\` : ''}

        <div class="card">
          <div class="card-header">RECENT EVOLUTION</div>
          <ul class="timeline">
            \${state.cycles.slice(0, 8).map(c => \`
              <li class="timeline-item" onclick="showCycleDetail('\${c.id}')" style="cursor:pointer">
                <div>
                  <div class="timeline-title">#\${c.cycle_number} \${c.selected_improvement || 'Pending'}</div>
                  <div class="timeline-meta">\${new Date(c.created_at).toLocaleString()} · \${c.commit_sha ? c.commit_sha.slice(0,7) : 'no commit'}</div>
                </div>
                <span class="timeline-status \${c.status}">\${c.status}</span>
              </li>
            \`).join('') || '<li class="empty"><p>No cycles yet. Click "Evolve Now" to start.</p></li>'}
          </ul>
        </div>
      \`;
    }

    function renderHistory() {
      document.getElementById('tab-history').innerHTML = \`
        <div class="card">
          <div class="card-header">EVOLUTION HISTORY</div>
          <ul class="timeline">
            \${state.cycles.map(c => \`
              <li class="timeline-item" onclick="showCycleDetail('\${c.id}')" style="cursor:pointer">
                <div>
                  <div class="timeline-title">#\${c.cycle_number} \${c.selected_improvement || c.status}</div>
                  <div class="timeline-meta">
                    \${new Date(c.created_at).toLocaleString()}
                    \${c.commit_sha ? '· ' + c.commit_sha.slice(0,7) : ''}
                    \${c.push_status ? '· push: ' + c.push_status : ''}
                    \${c.deploy_status ? '· deploy: ' + c.deploy_status : ''}
                  </div>
                  \${c.lessons_learned ? '<div class="timeline-meta" style="margin-top:4px">' + c.lessons_learned.slice(0,120) + '</div>' : ''}
                </div>
                <div style="text-align:right">
                  <span class="timeline-status \${c.status}">\${c.status}</span>
                  \${c.quality_after !== null ? '<div class="stat-label" style="margin-top:4px">Q: ' + c.quality_after + '</div>' : ''}
                </div>
              </li>
            \`).join('') || '<li class="empty"><p>No evolution history yet.</p></li>'}
          </ul>
        </div>
      \`;
    }

    function renderIdeas() {
      document.getElementById('tab-ideas').innerHTML = \`
        <div class="card">
          <div class="card-header">IDEAS & PROPOSALS</div>
          <ul class="timeline">
            \${state.ideas.map(i => \`
              <li class="timeline-item">
                <div>
                  <div class="timeline-title">\${i.title}</div>
                  <div class="timeline-meta">\${i.description?.slice(0,100) || ''}</div>
                  <div class="timeline-meta" style="margin-top:4px">
                    Impact: \${i.impact} · Confidence: \${i.confidence} · Effort: \${i.effort} · Priority: \${i.priority_score?.toFixed(1)}
                  </div>
                </div>
                <span class="badge \${i.status === 'selected' ? 'green' : i.status === 'rejected' ? 'red' : 'blue'}">\${i.status}</span>
              </li>
            \`).join('') || '<li class="empty"><p>No ideas generated yet.</p></li>'}
          </ul>
        </div>
      \`;
    }

    function renderUsage() {
      const u = state.usage;
      if (!u) return;
      const t = u.totals || {};
      document.getElementById('tab-usage').innerHTML = \`
        <div class="grid">
          <div class="card">
            <div class="card-header">TOTAL REQUESTS</div>
            <div class="stat">\${t.totalRequests || 0}</div>
          </div>
          <div class="card">
            <div class="card-header">INPUT TOKENS</div>
            <div class="stat">\${(t.totalInputTokens || 0).toLocaleString()}</div>
          </div>
          <div class="card">
            <div class="card-header">OUTPUT TOKENS</div>
            <div class="stat">\${(t.totalOutputTokens || 0).toLocaleString()}</div>
          </div>
          <div class="card">
            <div class="card-header">EST. COST</div>
            <div class="stat">$\${(t.totalCost || 0).toFixed(4)}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">RECENT USAGE</div>
          <ul class="timeline">
            \${(u.usage || []).slice(0, 20).map(r => \`
              <li class="timeline-item">
                <div>
                  <div class="timeline-title">\${r.agent} → \${r.model}</div>
                  <div class="timeline-meta">\${new Date(r.created_at).toLocaleString()} · \${r.input_tokens + r.output_tokens} tokens</div>
                </div>
              </li>
            \`).join('') || '<li class="empty"><p>No usage recorded yet.</p></li>'}
          </ul>
        </div>
      \`;
    }

    function renderConfig() {
      document.getElementById('tab-config').innerHTML = \`
        <div class="card">
          <div class="card-header">SYSTEM CONFIGURATION</div>
          <div class="stat-row"><span>Evolution Interval</span><span>\${state.status?.worker?.intervalMinutes || 30} min</span></div>
          <div class="stat-row"><span>Max Cycles/Day</span><span>\${state.status?.worker?.maxCyclesPerDay || 48}</span></div>
          <div class="stat-row"><span>LLM Provider</span><span>Gateway</span></div>
          <div class="stat-row"><span>Deploy Strategy</span><span>\${state.status?.deploy?.running ? 'Local' : 'Not deployed'}</span></div>
        </div>
      \`;
    }

    let timelineSnapshots = [];
    let activeVersionCycleId = null;
    let activeVersionFiles = [];
    let activeFileIndex = 0;
    let versionViewMode = 'code';

    async function loadTimeline() {
      try {
        timelineSnapshots = await fetchApi('/snapshots');
      } catch { timelineSnapshots = []; }
    }

    async function renderTimeline() {
      await loadTimeline();

      const cycleMap = {};
      state.cycles.forEach(c => { cycleMap[c.id] = c; });

      if (!timelineSnapshots.length && !state.cycles.length) {
        document.getElementById('tab-timeline').innerHTML = \`
          <div class="card"><div class="empty"><p>No versions yet. Trigger an evolution cycle to create the first version.</p></div></div>\`;
        return;
      }

      const allVersions = [];
      // Add current app state as "live"
      allVersions.push({ version: 'current', cycleId: null, label: 'Live', created_at: new Date().toISOString() });
      // Add snapshot versions
      const seen = new Set();
      for (const s of timelineSnapshots) {
        const cid = s.cycle_id || s.cycleId;
        if (!seen.has(cid)) {
          seen.add(cid);
          const cycle = cycleMap[cid];
          allVersions.push({
            version: s.version,
            cycleId: cid,
            label: 'v' + s.version,
            created_at: s.created_at || s.createdAt,
            cycle
          });
        }
      }

      document.getElementById('tab-timeline').innerHTML = \`
        <div class="card" style="margin-bottom:16px">
          <div class="card-header">APP VERSIONS TIMELINE</div>
          <p style="font-size:11px;color:var(--text-2);margin-bottom:12px">Click a version to browse its files and preview the app at that point in time.</p>
          <div class="timeline-versions">
            \${allVersions.map(v => \`
              <div class="version-card \${activeVersionCycleId === v.cycleId ? 'active' : ''}" data-cycle="\${v.cycleId}" onclick="viewVersion('\${v.cycleId}', '\${v.version}')">
                <div class="v-num">\${v.label}</div>
                <div class="v-meta">\${new Date(v.created_at).toLocaleDateString()}</div>
                \${v.cycle ? '<div class="v-cycle">#' + v.cycle.cycle_number + ': ' + (v.cycle.selected_improvement || '').slice(0,40) + '</div>' : ''}
              </div>
            \`).join('')}
          </div>
        </div>
        <div id="version-content"></div>
      \`;
    }

    async function viewVersion(cycleId, version) {
      activeVersionCycleId = cycleId;
      activeFileIndex = 0;
      versionViewMode = 'code';

      if (cycleId === 'null' || !cycleId) {
        // Show live app files
        try {
          const statusData = await fetchApi('/status');
          document.getElementById('version-content').innerHTML = \`
            <div class="card">
              <div class="card-header"><span class="dot green"></span> LIVE VERSION</div>
              <p style="color:var(--text-2);font-size:12px">This is the current live version of the evolving app. It reflects the latest state on disk.</p>
              \${statusData.deploy?.url ? '<div style="margin-top:12px"><a href="' + statusData.deploy.url + '" target="_blank" style="font:500 12px/1 var(--sans)">Open Live App →</a></div>' : ''}
            </div>
          \`;
        } catch (e) {
          document.getElementById('version-content').innerHTML = '<div class="card"><p style="color:var(--rose)">Error loading live state</p></div>';
        }
        return;
      }

      try {
        activeVersionFiles = await fetchApi('/snapshots/' + cycleId);
        // Update active card styling
        document.querySelectorAll('.version-card').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.version-card').forEach(c => {
          if (c.getAttribute('data-cycle') === cycleId) c.classList.add('active');
        });
        renderVersionViewer(version);
      } catch (e) {
        document.getElementById('version-content').innerHTML = '<div class="card"><p style="color:var(--rose)">No snapshot available for this version</p></div>';
      }
    }

    function renderVersionViewer(version) {
      if (!activeVersionFiles.length) {
        document.getElementById('version-content').innerHTML = '<div class="card"><div class="empty"><p>No files in this snapshot.</p></div></div>';
        return;
      }

      const currentFile = activeVersionFiles[activeFileIndex];
      const isHtml = (currentFile.file_path||currentFile.filePath||'').endsWith('.html') || (currentFile.file_path||currentFile.filePath||'').endsWith('.htm');
      const fp = currentFile.file_path || currentFile.filePath || '';
      const ext = fp.split('.').pop() || '';
      const langMap = { js: 'javascript', ts: 'typescript', json: 'json', css: 'css', html: 'html', md: 'markdown' };

      const lines = currentFile.content.split('\\n');
      const numberedLines = lines.map((line, i) =>
        '<span class="line-num">' + (i + 1) + '</span>' + escapeHtml(line)
      ).join('\\n');

      document.getElementById('version-content').innerHTML = \`
        <div class="version-tabs">
          <button class="\${versionViewMode === 'code' ? 'active' : ''}" onclick="setViewMode('code')">Code</button>
          \${isHtml ? '<button class="' + (versionViewMode === 'preview' ? 'active' : '') + '" onclick="setViewMode(\\'preview\\')">Preview</button>' : ''}
        </div>
        <div class="version-viewer">
          <div class="version-sidebar">
            \${activeVersionFiles.map((f, i) => \`
              <div class="file-item \${i === activeFileIndex ? 'active' : ''}" onclick="selectFile(\${i})">
                \${getFileIcon(f.file_path||f.filePath)} \${f.file_path||f.filePath}
              </div>
            \`).join('')}
          </div>
          <div class="version-code">
            <div class="version-header">\${fp} · v\${version} · \${lines.length} lines</div>
            \${versionViewMode === 'preview' && isHtml
              ? '<div class="version-iframe-wrap"><iframe id="previewFrame" sandbox="allow-scripts"></iframe></div>'
              : '<pre>' + numberedLines + '</pre>'
            }
          </div>
        </div>
      \`;

      if (versionViewMode === 'preview' && isHtml) {
        const frame = document.getElementById('previewFrame');
        if (frame) frame.srcdoc = currentFile.content;
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function getFileIcon(path) {
      const ext = path.split('.').pop();
      const icons = { js: '📜', ts: '📘', html: '🌐', css: '🎨', json: '📋', md: '📝' };
      return icons[ext] || '📄';
    }

    function selectFile(index) {
      activeFileIndex = index;
      const version = activeVersionFiles[0] ? 'snapshot' : '';
      renderVersionViewer(version);
    }

    function setViewMode(mode) {
      versionViewMode = mode;
      const version = activeVersionFiles[0] ? 'snapshot' : '';
      renderVersionViewer(version);
    }

    async function showCycleDetail(id) {
      try {
        const detail = await fetchApi('/cycles/' + id);
        document.getElementById('detailBody').innerHTML = \`
          <h2 style="font:600 16px/1.4 var(--sans);margin-bottom:16px">
            Cycle #\${detail.cycle_number}: \${detail.selected_improvement || detail.status}
          </h2>
          <div class="grid" style="margin-bottom:16px">
            <div><span class="badge \${detail.status === 'completed' ? 'green' : detail.status === 'failed' ? 'red' : 'amber'}">\${detail.status}</span></div>
            <div class="stat-label">\${new Date(detail.created_at).toLocaleString()}</div>
            \${detail.commit_sha ? '<div class="stat-label">Commit: ' + detail.commit_sha.slice(0,7) + '</div>' : ''}
          </div>

          \${detail.observation ? '<div class="detail-section"><h3>Observations</h3><pre>' + detail.observation.slice(0,2000) + '</pre></div>' : ''}
          \${detail.selection_reason ? '<div class="detail-section"><h3>Selection Reason</h3><p style="color:var(--text-2)">' + detail.selection_reason + '</p></div>' : ''}
          \${detail.implementation_plan ? '<div class="detail-section"><h3>Implementation Plan</h3><pre>' + detail.implementation_plan.slice(0,2000) + '</pre></div>' : ''}
          \${detail.files_modified ? '<div class="detail-section"><h3>Files Modified</h3><pre>' + detail.files_modified + '</pre></div>' : ''}
          \${detail.test_results ? '<div class="detail-section"><h3>Test Results</h3><pre>' + detail.test_results.slice(0,1000) + '</pre></div>' : ''}
          \${detail.lessons_learned ? '<div class="detail-section"><h3>Lessons Learned</h3><p style="color:var(--text-2)">' + detail.lessons_learned + '</p></div>' : ''}
          \${detail.error_message ? '<div class="detail-section"><h3>Error</h3><pre style="color:var(--rose)">' + detail.error_message + '</pre></div>' : ''}

          <div class="detail-section"><h3>Quality</h3>
            <div class="stat-row"><span>Before</span><span>\${detail.quality_before ?? 'N/A'}</span></div>
            <div class="stat-row"><span>After</span><span>\${detail.quality_after ?? 'N/A'}</span></div>
          </div>
        \`;
        document.getElementById('detailModal').classList.add('open');
      } catch (e) {
        console.error(e);
      }
    }

    function closeDetail() {
      document.getElementById('detailModal').classList.remove('open');
    }

    document.querySelectorAll('.topbar nav button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.topbar nav button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        ['overview','timeline','history','ideas','usage','config'].forEach(t => {
          document.getElementById('tab-' + t).style.display = t === tab ? 'block' : 'none';
        });
        currentTab = tab;
        if (tab === 'timeline' && !activeVersionCycleId) renderTimeline();
      });
    });

    async function triggerEvolve() {
      const btn = document.getElementById('evolveBtn');
      btn.disabled = true;
      btn.textContent = 'Running...';
      try {
        await fetch('/api/evolve', { method: 'POST' });
      } catch (e) {
        console.error(e);
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Evolve Now';
        loadData();
      }, 5000);
    }

    document.getElementById('detailModal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('detailModal')) closeDetail();
    });

    loadData();
    refreshInterval = setInterval(loadData, 10000);
  </script>
</body>
</html>`;
}
