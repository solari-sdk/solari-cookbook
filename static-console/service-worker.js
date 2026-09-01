const CACHE='solari-static-shell-v4';
const SHELL=['./','./index.html','./styles.css','./app.js','./storage.js','./sources.js','./broker.js','./schema.js','./crypto.js','./security.js','./exports.js','./artifacts.js','./filters.js','./merge.js','./graph.js','./graph-bootstrap.js','./manifest.webmanifest'];
self.addEventListener('install',(event)=>event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(SHELL))));
self.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then((names)=>Promise.all(names.filter((name)=>name!==CACHE).map((name)=>caches.delete(name))))));
self.addEventListener('fetch',(event)=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request).then((response)=>{const copy=response.clone();caches.open(CACHE).then((cache)=>cache.put(event.request,copy));return response;}).catch(()=>caches.match(event.request).then((cached)=>cached||caches.match('./index.html'))));});
