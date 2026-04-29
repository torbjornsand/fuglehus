export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ── Favoritter ──────────────────────────────────────────
    if (url.pathname === '/favorites') {
      if (request.method === 'GET') {
        const val = await env.FAVORITES.get('list');
        const liste = val ? JSON.parse(val) : [];
        return new Response(JSON.stringify(liste), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'POST') {
        const { navn } = await request.json();
        const val = await env.FAVORITES.get('list');
        let liste = val ? JSON.parse(val) : [];
        const idx = liste.indexOf(navn);
        if (idx === -1) liste.push(navn);
        else liste.splice(idx, 1);
        await env.FAVORITES.put('list', JSON.stringify(liste));
        return new Response(JSON.stringify({ favorites: liste }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── High fives ──────────────────────────────────────────
    if (url.pathname === '/highfives') {
      const val   = await env.FAVORITES.get('highfives');
      const count = val ? parseInt(val) : 0;

      if (request.method === 'GET') {
        return new Response(JSON.stringify({ count }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'POST') {
        const next = count + 1;
        await env.FAVORITES.put('highfives', String(next));
        return new Response(JSON.stringify({ count: next }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── Ta bilde (eksisterende) ──────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    const response = await fetch('https://kvitrehus.com/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
