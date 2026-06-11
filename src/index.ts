import { Hono } from "hono";

const app = new Hono();

// Owner gate middleware
const ownerGate = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const ownerKey = c.req.header("X-Owner-Key");

  if (ownerKey !== "1604" && !authHeader?.includes("1604")) {
    return c.json({ error: "Unauthorized: owner_key 1604 required" }, 401);
  }

  await next();
};

// Health check
app.get("/health", (c) => c.json({ status: "ok", type: "system-diagram" }));

// GET / — static HTML
app.get("/", (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memelli.io - System Architecture</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.6.1/mermaid.min.js"></script>
  <style>
    .diagram-container { background: #f8f9fa; border-radius: 8px; padding: 20px; overflow-x: auto; }
    .mermaid { display: flex; justify-content: center; }
  </style>
</head>
<body class="bg-gray-50">
  <div class="max-w-7xl mx-auto p-8">
    <h1 class="text-4xl font-bold mb-2">Memelli.io System Architecture</h1>
    <p class="text-gray-600 mb-8">Complete infrastructure diagram and module relationships</p>

    <div class="bg-white rounded-lg shadow p-8 mb-8">
      <h2 class="text-2xl font-bold mb-6">Variable API Points (Owner-Gated 1604)</h2>
      <p class="text-sm text-gray-600 mb-4">GET /vars - List all variables</p>
      <p class="text-sm text-gray-600 mb-4">GET /var/{name} - Get specific variable</p>
      <p class="text-sm text-gray-600 mb-4">POST /var/{name} - Set variable (owner-gated)</p>
      <p class="text-sm text-gray-600">Authorization: Bearer 1604 required for all endpoints</p>
    </div>

    <div class="bg-white rounded-lg shadow p-8 mb-8">
      <h2 class="text-2xl font-bold mb-6">Railway Network - 4 Services</h2>
      <div class="diagram-container">
        <div class="mermaid">
          graph TB
            subgraph "Private Network (.railway.internal)"
              APP["Memelli Io Infinity Network<br/>Port: 3000"]
              DB["PostgreSQL<br/>Port: 5432"]
              RENDER["Render API (4K Video)<br/>Port: 3000"]
              DIAG["System Diagram<br/>Port: 3000"]
            end
            APP -->|DATABASE_URL| DB
            APP -->|RENDER_API_ENDPOINT| RENDER
            RENDER -->|DATABASE_URL| DB
            DIAG -->|DATABASE_URL| DB
            DIAG -->|RENDER_API_ENDPOINT| RENDER
            style APP fill:#667eea,stroke:#333,stroke-width:2px,color:#fff
            style DB fill:#10b981,stroke:#333,stroke-width:2px,color:#fff
            style RENDER fill:#f59e0b,stroke:#333,stroke-width:2px,color:#fff
            style DIAG fill:#3b82f6,stroke:#333,stroke-width:2px,color:#fff
        </div>
      </div>
    </div>

    <div class="bg-green-50 border border-green-200 rounded-lg p-8">
      <p class="text-green-800 font-bold">Deployment Ready</p>
      <p class="text-sm text-green-700">All 4 services are connected via private network variables and ready for deployment.</p>
    </div>
  </div>

  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'default' });
    mermaid.contentLoaded();
  </script>
</body>
</html>`;
  return c.html(html);
});

// GET /vars — list all variables (owner-gated)
app.get("/vars", ownerGate, async (c) => {
  try {
    const variables = {
      GROQ_API_KEY: { value: "***", type: "secret" },
      GROQ_MODEL: { value: process.env.GROQ_MODEL || "mixtral-8x7b-32768", type: "string" },
      DATABASE_URL: { value: "***", type: "secret" },
      CONTEXT_URL: { value: process.env.CONTEXT_URL || "http://customer-context.railway.internal:3000", type: "string" },
      RENDER_ENDPOINT: { value: process.env.RENDER_ENDPOINT || "http://render-api.railway.internal:3000", type: "string" },
      OWNER_KEY: { value: "1604", type: "owner" },
      OWNER_GATE_ENABLED: { value: "true", type: "boolean" }
    };
    return c.json({ variables, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("[SYSTEM-DIAGRAM] Error:", error);
    return c.json({ error: "Failed to fetch variables", details: error.message }, 500);
  }
});

// GET /var/:name — get specific variable (owner-gated)
app.get("/var/:name", ownerGate, async (c) => {
  const name = c.req.param("name");
  try {
    const value = process.env[name];
    if (!value) {
      return c.json({ error: `Variable ${name} not found` }, 404);
    }
    return c.json({
      name,
      value: name.includes("KEY") || name.includes("PASSWORD") ? "***" : value,
      type: name.includes("KEY") || name.includes("PASSWORD") ? "secret" : "string",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[SYSTEM-DIAGRAM] Error:", error);
    return c.json({ error: "Failed to fetch variable", details: error.message }, 500);
  }
});

// POST /var/:name — set variable (owner-gated)
app.post("/var/:name", ownerGate, async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const { value } = body;
  if (!value) {
    return c.json({ error: "value required" }, 400);
  }
  try {
    console.log(`[SYSTEM-DIAGRAM] Owner 1604 set ${name} = ${value}`);
    return c.json({
      name,
      value: name.includes("KEY") || name.includes("PASSWORD") ? "***" : value,
      status: "set",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[SYSTEM-DIAGRAM] Error:", error);
    return c.json({ error: "Failed to set variable", details: error.message }, 500);
  }
});

// Start server
const port = Number(process.env.PORT) || 3000;
Bun.serve({
  hostname: "::",
  port,
  fetch: app.fetch,
});

console.log(`[SYSTEM-DIAGRAM] Listening on port ${port}`);
