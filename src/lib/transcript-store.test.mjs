import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('./transcript-store.ts',import.meta.url),'utf8')
  .replace(/import \{ BQ_PROJECT, BQ_DATASET \} from "@\/lib\/bigquery-schema";/,'const BQ_PROJECT="youtubetranscripts-429803";const BQ_DATASET="reptranscripts";');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {buildSegmentRows,replaceTranscriptSql,replaceTranscript,REPLACE_TRANSCRIPT_TYPES,DEFAULT_TRANSCRIPT_TABLES}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('segment rows keep the app shape: padded ids, next-start end times, last end null',()=>{
  const rows=buildSegmentRows('abcdefghijk',[{start:0.5,text:'one'},{Start:'2',Text:'two'},{start:4,text:3}]);
  assert.deepEqual(rows.map(r=>r.segment_id),['abcdefghijk:00000','abcdefghijk:00001','abcdefghijk:00002']);
  assert.deepEqual(rows.map(r=>[r.segment_index,r.line_index]),[[0,0],[1,1],[2,2]]);
  assert.deepEqual(rows.map(r=>r.end_sec),[2,4,null]);
  assert.deepEqual(rows.map(r=>r.text),['one','two','3']);
});
test('a missing or garbage start never becomes NaN',()=>{
  const rows=buildSegmentRows('abcdefghijk',[{start:'x',text:'a'},{text:'b'}]);
  assert.equal(rows[0].start_sec,null);assert.equal(rows[0].end_sec,null);assert.equal(rows[1].start_sec,0);
});
test('the write is one transaction that replaces segments and asserts exact counts',()=>{
  const sql=replaceTranscriptSql();
  assert.match(sql,/^\s*BEGIN TRANSACTION;/);assert.match(sql,/COMMIT TRANSACTION;\s*$/);
  assert.match(sql,/MERGE `youtubetranscripts-429803\.reptranscripts\.youtube_videos`/);
  assert.match(sql,/DELETE FROM `youtubetranscripts-429803\.reptranscripts\.youtube_transcript_segments` WHERE video_id = @video_id/);
  assert.match(sql,/ASSERT \(SELECT COUNT\(\*\) FROM `[^`]+youtube_videos` WHERE video_id = @video_id\) = 1/);
  assert.match(sql,/= COALESCE\(ARRAY_LENGTH\(@segments\), 0\)/,"an empty array binds as NULL");
  assert.ok(sql.indexOf('DELETE FROM')<sql.indexOf('INSERT INTO'));
  assert.doesNotMatch(sql,/vitrupo|caption_timing_process|grading_timestamp/,'columns owned by other jobs are left alone');
});
test('table names are validated before they reach SQL',()=>{
  assert.throws(()=>replaceTranscriptSql({videos:'p.d.t; DROP TABLE x',segments:'p.d.s'}),/Invalid table identifier/);
  assert.match(replaceTranscriptSql({videos:'p-1.d.v',segments:'p-1.d.s'}),/`p-1\.d\.v`/);
});
test('replaceTranscript sends typed params so null fields and empty transcripts bind',async()=>{
  const calls=[];const fake={query:async o=>{calls.push(o);return [[]]}};
  const video={video_id:'abcdefghijk',video_title:null,channel_name:'c',published_date:'2026-01-02',youtube_link:null,video_length:null,speaker_source:'A, B',created_time:'2026-10-04T00:00:00.000Z'};
  await replaceTranscript(fake,video,[]);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].params,{...video,segments:[]});
  assert.equal(calls[0].types,REPLACE_TRANSCRIPT_TYPES);
  assert.equal(calls[0].types.segments[0].end_sec,'FLOAT64');
  assert.equal(DEFAULT_TRANSCRIPT_TABLES.segments,'youtubetranscripts-429803.reptranscripts.youtube_transcript_segments');
});
