import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialize, identity, command, guest, snapshot, cleanup, sameOrigin } from '../lib/chat-server.ts';

function database() {
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../drizzle/0002_nice_champions.sql',import.meta.url),'utf8'));
  const db={prepare(query){
    const statement=sql.prepare(query);let args=[];
    return {bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return {results:statement.all(...args)};},async run(){const result=statement.run(...args);return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};},
    async batch(statements){sql.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,db};
}
async function add(db) {
  const response=await initialize(new Request('https://test.local/api/chat/init'),db);
  const cookie=response.headers.get('Set-Cookie').split(';')[0];
  return await identity(new Request('https://test.local',{headers:{cookie}}));
}
test('atomic pairing, room isolation, Next, Stop, blocks and durable reports', async()=>{
  const {db,sql}=database();
  const a=await add(db),b=await add(db),c=await add(db),d=await add(db);
  await command(db,a,{type:'join'});assert.equal((await guest(db,a)).state,'waiting');
  await command(db,b,{type:'join'});
  const room=(await guest(db,a)).room;assert.ok(room);assert.equal((await guest(db,b)).room,room);
  assert.notEqual((await snapshot(db,a)).initiator,(await snapshot(db,b)).initiator);
  await command(db,a,{type:'signal',room,kind:'offer',payload:{type:'offer',sdp:'test'}});
  assert.equal((await snapshot(db,b)).signals.length,1);assert.equal((await snapshot(db,c)).signals.length,0);
  await assert.rejects(command(db,c,{type:'signal',room,kind:'offer',payload:{}}),/ended/);
  await command(db,a,{type:'join'});assert.equal((await guest(db,b)).state,'waiting');
  assert.equal((await guest(db,a)).state,'waiting');
  await assert.rejects(command(db,a,{type:'signal',room,kind:'ice',payload:{}}),/ended/);
  await command(db,c,{type:'join'});assert.equal((await guest(db,c)).partner,b);
  await command(db,d,{type:'join'});assert.equal((await guest(db,d)).partner,a);
  const reportRoom=(await guest(db,a)).room;
  const report=await command(db,a,{type:'report',room:reportRoom,reason:'Harassment or hate'});
  assert.ok(report.reportId);assert.equal(sql.prepare('SELECT COUNT(*) n FROM chat_reports').get().n,1);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM chat_blocks').get().n,1);
  sql.prepare('UPDATE chat_guests SET last_partner=NULL').run();
  await snapshot(db,a);assert.equal((await guest(db,a)).state,'waiting');
  await command(db,c,{type:'stop'});assert.equal((await guest(db,c)).state,'idle');assert.equal((await guest(db,b)).state,'waiting');
  await snapshot(db,a);assert.equal((await guest(db,a)).partner,b);
  sql.close();
});
test('expired peers are released, signals cleaned, and commands throttled',async()=>{
  const {db,sql}=database();const a=await add(db),b=await add(db);
  await command(db,a,{type:'join'});await command(db,b,{type:'join'});
  sql.prepare('UPDATE chat_guests SET seen=0 WHERE id=?').run(b);
  assert.equal((await snapshot(db,a)).state,'waiting');
  sql.prepare("INSERT INTO chat_signals(recipient,room,kind,payload,created) VALUES(?,'old','ice','{}',0)").run(a);
  await cleanup(db);assert.equal(sql.prepare('SELECT COUNT(*) n FROM chat_signals').get().n,0);
  sql.prepare('UPDATE chat_guests SET rate_start=?,rate_count=180 WHERE id=?').run(Date.now(),a);
  await assert.rejects(command(db,a,{type:'join'}),/Too many/);
  assert.equal(sameOrigin(new Request('https://test.local',{headers:{origin:'https://evil.local'}})),false);
  assert.equal(await identity(new Request('https://test.local',{headers:{cookie:'lr_guest=forged'}})),null);
  sql.close();
});
