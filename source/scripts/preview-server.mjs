import { createServer } from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('dist'),port=Number(process.env.EMA_PREVIEW_PORT||4173);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.wav':'audio/wav','.wasm':'application/wasm','.ttf':'font/ttf'};
createServer(async(req,res)=>{
  try{
    let relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/icu-cognition-ema\//,'').replace(/^\//,'');
    if(!relative||relative.endsWith('/'))relative+='index.html';
    const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    await stat(file);res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-cache');res.end(await readFile(file));
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Built preview: http://localhost:${port}/icu-cognition-ema/ (local computer only)`));
