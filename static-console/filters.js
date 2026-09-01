function numberOrNull(value){const parsed=Number(value);return value===''||value==null||!Number.isFinite(parsed)?null:parsed;}

export function normalizeFilterState(state={}){
  return {
    query:String(state.query||'').trim(),source:String(state.source||''),category:String(state.category||''),severity:String(state.severity||''),
    min_quality:Math.max(0,Math.min(1,numberOrNull(state.min_quality)??0)),hours:Math.max(0,numberOrNull(state.hours)??0),
    min_lat:numberOrNull(state.min_lat),max_lat:numberOrNull(state.max_lat),min_lon:numberOrNull(state.min_lon),max_lon:numberOrNull(state.max_lon),
  };
}

export function eventFreshness(event,now=Date.now()){
  const observed=Date.parse(event?.updated_at||event?.observed_at||'');
  if(!Number.isFinite(observed))return{age_hours:null,label:'Unknown',state:'unknown'};
  const age=Math.max(0,(now-observed)/3600000);
  return{age_hours:age,label:age<1?`${Math.max(0,Math.round(age*60))}m`:age<48?`${age.toFixed(1)}h`:`${(age/24).toFixed(1)}d`,state:age<=1?'fresh':age<=24?'recent':'stale'};
}

export function eventFacets(events){
  return{
    sources:[...new Set(events.map((event)=>event.source_id).filter(Boolean))].sort(),
    categories:[...new Set(events.map((event)=>event.category).filter(Boolean))].sort(),
  };
}

export function applyEventFilters(events,state={},now=Date.now()){
  const filter=normalizeFilterState(state);const query=filter.query.toLocaleLowerCase();
  return events.filter((event)=>{
    if(filter.source&&event.source_id!==filter.source)return false;
    if(filter.category&&event.category!==filter.category)return false;
    if(filter.severity&&event.severity!==filter.severity)return false;
    if(Number(event.quality_score??0)<filter.min_quality)return false;
    if(query){const haystack=[event.title,event.summary,event.source_id,event.category,...Object.values(event.properties||{})].filter((value)=>value!=null).join(' ').toLocaleLowerCase();if(!haystack.includes(query))return false;}
    if(filter.hours>0){const freshness=eventFreshness(event,now);if(freshness.age_hours===null||freshness.age_hours>filter.hours)return false;}
    const lat=Number(event.latitude),lon=Number(event.longitude),hasGeo=Number.isFinite(lat)&&Number.isFinite(lon);
    if(filter.min_lat!==null&&(!hasGeo||lat<filter.min_lat))return false;
    if(filter.max_lat!==null&&(!hasGeo||lat>filter.max_lat))return false;
    if(filter.min_lon!==null&&(!hasGeo||lon<filter.min_lon))return false;
    if(filter.max_lon!==null&&(!hasGeo||lon>filter.max_lon))return false;
    return true;
  });
}
