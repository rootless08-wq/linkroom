// Local-only UI and real-WebRTC harness; never used by the production Worker.
import { createServer as httpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { handleRooms, handleSignals } from '../lib/private-server.ts';
import { initialize, identity, command, snapshot } from '../lib/chat-server.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const sqlite=new DatabaseSync(':memory:');
for (const name of ['0002_nice_champions.sql','0003_secure_private_rooms.sql']) sqlite.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
const db={prepare(query){const statement=sqlite.prepare(query);let args=[];return{bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return{results:statement.all(...args)};},async run(){const r=statement.run(...args);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};},async batch(items){sqlite.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const vite=await createServer({root,configFile:false,plugins:[react()],resolve:{alias:{'@':root},dedupe:['react','react-dom']},server:{middlewareMode:true,hmr:false},optimizeDeps:{force:true},appType:'custom'});
httpServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:3001');
  if(url.pathname.startsWith('/api/')){
   let raw='';for await(const chunk of req)raw+=chunk;
   const request=new Request(url,{method:req.method,headers:req.headers,...(raw?{body:raw}:{})});
   let response;
   if(url.pathname==='/api/rooms')response=await handleRooms(request,db);
   else if(url.pathname==='/api/signals')response=await handleSignals(request,db);
   else if(url.pathname==='/api/chat/init')response=await initialize(request,db);
   else if(url.pathname==='/api/chat'){
    const id=await identity(request);
    response=Response.json(req.method==='POST'?await command(db,id,JSON.parse(raw)):await snapshot(db,id,Number(url.searchParams.get('after')||0)));
   }else response=new Response('Not found',{status:404});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if(['/','/private','/__test'].includes(url.pathname)){
   const html=await vite.transformIndexHtml(url.pathname,'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/preview.tsx"></script></body></html>');
   res.writeHead(200,{'Content-Type':'text/html'});res.end(html);return;
  }
  vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
 }catch(e){res.writeHead(500);res.end(String(e));}
}).listen(3001,'127.0.0.1',()=>console.log('LinkRoom test preview: http://127.0.0.1:3001'));
