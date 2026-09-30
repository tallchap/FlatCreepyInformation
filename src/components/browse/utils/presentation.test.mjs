import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('./presentation.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {initialLetter,initials,sortSpeakers,pageNumbers,yearOf,displayDate,duration,playableMediaUrl}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const speakers=[{name:'Zoë',videoCount:3,updatedAt:null},{name:'Álvaro',videoCount:9,updatedAt:'2026-01-02'},{name:'Alice',videoCount:9,updatedAt:'2026-09-02'}];
test('directory filtering handles accented initials, punctuation and whitespace',()=>{
  assert.equal(initialLetter(' Élodie'),'E');assert.equal(initialLetter('3Blue1Brown'),'#');assert.equal(initials('  Ada   Lovelace '),'AL');
  assert.deepEqual(sortSpeakers(speakers,'content','A','  alice ').map(s=>s.name),['Alice']);
  assert.equal(sortSpeakers(speakers,'content','Z','alice').length,0);
});
test('sorting is deterministic, preserves data and puts missing dates last',()=>{
  assert.deepEqual(sortSpeakers(speakers,'recent','All','').map(s=>s.name),['Alice','Álvaro','Zoë']);
  assert.deepEqual(sortSpeakers(speakers,'content','All','').map(s=>s.name),['Alice','Álvaro','Zoë']);
  assert.equal(speakers[0].name,'Zoë');
});
test('large catalogs never render hundreds of pagination buttons',()=>{
  for(const page of [1,2,40,85,86]){
    const pages=pageNumbers(page,86),numbers=pages.filter(n=>typeof n==='number');
    assert.ok(numbers.includes(page));assert.equal(numbers[0],1);assert.equal(numbers.at(-1),86);
    assert.ok(pages.length<=9);assert.equal(new Set(numbers).size,numbers.length);
  }
  assert.deepEqual(pageNumbers(1,1),[1]);assert.deepEqual(pageNumbers(1,0),[]);
});
test('missing dates and durations have honest display values',()=>{
  assert.equal(yearOf(''),'Undated');assert.equal(yearOf('2026-09-29'),'2026');
  assert.equal(displayDate(''),'Date unavailable');assert.equal(displayDate('2026-01-01'),'Jan 1, 2026');
  assert.equal(duration(61000),'1:01');assert.equal(duration(-1000),'0:00');
});

test('legacy GCS URIs are converted to playable HTTPS media',()=>{
  assert.equal(playableMediaUrl('gs://snippysaurus-clips/clips/example.mp4'),'https://storage.googleapis.com/snippysaurus-clips/clips/example.mp4');
  assert.equal(playableMediaUrl('https://example.com/clip.mp4'),'https://example.com/clip.mp4');
  assert.equal(playableMediaUrl('javascript:alert(1)'),null);assert.equal(playableMediaUrl('broken'),null);
});
