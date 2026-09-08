// V1 dashboard: node:http + SSE + single-file HTML/JS (zero deps, no build).
// Live mode: subscribes to the EventBus and pushes ToolEvents to SSE clients.
// Replay mode: reads trace.jsonl and feeds the SAME ToolEvents to SSE clients.
// Both paths deliver identical events to the same frontend render code.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, 'public', 'index.html');

export const DEFAULT_PORT = 9377;

/** Read a recorded trace.jsonl → ToolEvent[] (replay source). */
export function replayEvents(tracePath) {
  if (!existsSync(tracePath)) throw new Error(`trace not found: ${tracePath}`);
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Start the dashboard.
 * @param {{port?:number, bus?:EventBus, tracePath?:string}} opts
 * @returns {{server, port, close}}
 */
export function startDashboard(opts = {}) {
  let port = opts.port || DEFAULT_PORT;
  const clients = new Set();
  const bus = opts.bus || null;
  const tracePath = opts.tracePath || null;
  const reportPath = opts.reportPath || (tracePath ? tracePath.replace(/trace\.jsonl$/, 'report.md') : null);

  let liveUnsub = null;
  if (bus) {
    liveUnsub = bus.on((te) => {
      broadcast('event', te);
    });
  }

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* client gone */ }
    }
  }

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(existsSync(INDEX_HTML) ? readFileSync(INDEX_HTML, 'utf8') : '<h1>dashboard index.html not found</h1>');
      return;
    }
    if (req.url === '/report' || req.url === '/report.md') {
      if (reportPath && existsSync(reportPath)) {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(readFileSync(reportPath, 'utf8'));
      } else {
        res.writeHead(404);
        res.end('report.md not yet available');
      }
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('event: hello\ndata: {}\n\n');

      // replay mode: stream recorded events then CLOSE the response (one-shot)
      if (tracePath) {
        try {
          for (const ev of replayEvents(tracePath)) {
            res.write(`event: event\ndata: ${JSON.stringify(ev)}\n\n`);
          }
          res.end('event: done\ndata: {}\n\n');
        } catch (e) {
          res.end(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
        }
        return;
      }

      // live mode: keep the connection open and stream future events
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  // bind with auto-increment on occupied port
  return new Promise((resolve) => {
    const tryListen = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          tryListen(p + 1);
        } else {
          throw err;
        }
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        console.log(`[dashboard] http://127.0.0.1:${actual}/  (requested ${port}${actual !== port ? ', auto-incremented' : ''})`);
        resolve({
          server,
          port: actual,
          close() {
            if (liveUnsub) liveUnsub();
            for (const c of clients) { try { c.end(); } catch {} }
            server.close();
          },
        });
      });
    };
    tryListen(port);
  });
}
