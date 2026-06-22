var CACHE = 'soderia-lardelli-v6';
var PRECACHE = [
  './css/styles.css',
  './js/app.js',
  './data/seed.json',
  './manifest.webmanifest',
  './icons/logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

var NETWORK_FIRST = ['index.html', 'config.js', 'js/app.js'];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE).then(function(cache){
      return cache.addAll(PRECACHE);
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(key){ return key !== CACHE; }).map(function(key){
          return caches.delete(key);
        })
      );
    }).then(function(){
      return self.clients.claim();
    })
  );
});

function isNetworkFirst(url){
  return NETWORK_FIRST.some(function(name){ return url.indexOf(name) !== -1; });
}

self.addEventListener('fetch', function(event){
  if (event.request.method !== 'GET') return;

  var url = event.request.url;

  if (isNetworkFirst(url)){
    event.respondWith(
      fetch(event.request).then(function(response){
        if (response && response.status === 200){
          var copy = response.clone();
          caches.open(CACHE).then(function(cache){
            cache.put(event.request, copy);
          });
        }
        return response;
      }).catch(function(){
        return caches.match(event.request);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(cached){
      if (cached) return cached;
      return fetch(event.request).then(function(response){
        if (response && response.status === 200 && response.type === 'basic'){
          var copy = response.clone();
          caches.open(CACHE).then(function(cache){
            cache.put(event.request, copy);
          });
        }
        return response;
      });
    })
  );
});
