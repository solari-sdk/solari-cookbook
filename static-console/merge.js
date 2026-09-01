function timestamp(record) {
  for (const key of ['updated_at','observed_at','created_at','exported_at']) {
    const value=Date.parse(record?.[key]||'');
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function same(left,right) { return JSON.stringify(left)===JSON.stringify(right); }

export function mergeRecordSets(existingRecords,incomingRecords,{idField='id'}={}) {
  const current=new Map((existingRecords||[]).filter(Boolean).map((item)=>[String(item[idField]??''),item]));
  const accepted=[]; const unresolved=[]; let duplicates=0; let keptExisting=0;
  for (const incoming of incomingRecords||[]) {
    const id=String(incoming?.[idField]??'').trim();
    if(!id){unresolved.push({id:null,reason:'missing-id',incoming});continue;}
    const existing=current.get(id);
    if(!existing){accepted.push(incoming);current.set(id,incoming);continue;}
    if(same(existing,incoming)){duplicates+=1;continue;}
    const before=timestamp(existing), after=timestamp(incoming);
    if(before!==null&&after!==null){
      if(after>before){accepted.push(incoming);current.set(id,incoming);} else {keptExisting+=1;}
      continue;
    }
    unresolved.push({id,reason:'divergent-record-without-comparable-timestamp',existing,incoming});
  }
  return {accepted,unresolved,stats:{incoming:(incomingRecords||[]).length,accepted:accepted.length,duplicates,kept_existing:keptExisting,unresolved:unresolved.length}};
}

export function analyzeBundleConflicts(existingByStore,bundle,stores) {
  const results={};
  for(const [store,key] of stores) results[store]=mergeRecordSets(existingByStore[store]||[],Array.isArray(bundle[key])?bundle[key]:[]);
  return results;
}
