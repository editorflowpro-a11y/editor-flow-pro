// ================================================================
// Editor Flow Pro — Service Worker (PWA)
// Estratégia: network-first. O app SEMPRE busca dados frescos.
// O cache só serve de reserva quando o usuário está offline.
// ================================================================

const CACHE = 'efp-v1';
const SHELL = [
  '/',
  '/app',
  '/login',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Instala e pré-carrega o "esqueleto" do app
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

// Limpa caches antigos ao atualizar
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: tenta a rede; se falhar (offline), usa o cache
self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Só intercepta GET. Nunca mexe em chamadas ao Supabase/Kiwify (POST, auth, dados).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Deixa passar direto qualquer coisa que não seja do próprio site
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Atualiza o cache com a versão fresca (só páginas e assets do site)
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy).catch(() => {}));
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match('/app.html'))
      )
  );
});
