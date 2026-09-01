const CACHE='solari-static-console-v1';
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest'];
self.addEventListener('install',(event)=>event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(ASSETS))));
self.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key))))));
self.addEventListener('fetch',(event)=>{
  if(event.request.method!=='GET') return;
  event.respondWith(fetch(event.request).then((response)=>{
    const copy=response.clone(); caches.open(CACHE).then((cache)=>cache.put(event.request,copy)); return response;
  }).catch(()=>caches.match(event.request)));
});
