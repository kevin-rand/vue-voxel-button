#!/usr/bin/env node
/**
 * Tiny static file server for demo.html — no dependencies, works on old Node.
 *
 *   node scripts/serve.cjs [port]
 *
 * Vite (`npm run dev`) is the normal way to run this project; this exists so the
 * no-build preview can load demo.html plus the shared engine module from disk.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.argv[2] || process.env.PORT || 5188)
const HOME = 'demo.html'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.vue': 'text/plain; charset=utf-8',
}

http
  .createServer(function (req, res) {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    const rel = urlPath === '/' ? HOME : urlPath.replace(/^\/+/, '')
    const file = path.resolve(ROOT, rel)

    if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }

    fs.readFile(file, function (err, buf) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found: ' + rel)
        return
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(buf)
    })
  })
  .listen(PORT, '127.0.0.1', function () {
    console.log('voxelize demo → http://127.0.0.1:' + PORT + '/')
  })
