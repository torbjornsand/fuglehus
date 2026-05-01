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

    if (url.pathname === '/highfives') {
      const val = await env.FAVORITES.get('highfives');
      const count = val ? parseInt(val, 10) : 0;

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

    if (url.pathname === '/eggpoll') {
      const val = await env.FAVORITES.get('eggpoll');
      let entries = val ? JSON.parse(val) : [];

      if (request.method === 'GET') {
        entries = Array.isArray(entries) ? entries : [];
        entries.sort((a, b) => {
          const dateCompare = String(a.date || '').localeCompare(String(b.date || ''));
          if (dateCompare !== 0) return dateCompare;
          return String(a.name || '').localeCompare(String(b.name || ''), 'nb');
        });

        return new Response(JSON.stringify({ entries }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'POST') {
        const body = await request.json();
        const name = String(body?.name || '').trim().slice(0, 40);
        const date = String(body?.date || '').trim();

        if (!name || !/^2026-05-(0[1-9]|[12][0-9]|3[01])$/.test(date)) {
          return new Response(JSON.stringify({ error: 'Invalid poll input' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        entries = Array.isArray(entries) ? entries : [];
        const normalizedName = name.toLocaleLowerCase('nb-NO');
        const nextEntry = {
          name,
          date,
          createdAt: new Date().toISOString(),
        };

        const existingIndex = entries.findIndex(
          (entry) => String(entry?.name || '').trim().toLocaleLowerCase('nb-NO') === normalizedName
        );

        if (existingIndex >= 0) {
          entries[existingIndex] = {
            ...entries[existingIndex],
            ...nextEntry,
          };
        } else {
          entries.push(nextEntry);
        }

        entries.sort((a, b) => {
          const dateCompare = String(a.date || '').localeCompare(String(b.date || ''));
          if (dateCompare !== 0) return dateCompare;
          return String(a.name || '').localeCompare(String(b.name || ''), 'nb');
        });

        await env.FAVORITES.put('eggpoll', JSON.stringify(entries));

        return new Response(JSON.stringify({ entries }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/eggcount') {
      const val = await env.FAVORITES.get('eggcount');
      let counts = val ? JSON.parse(val) : {};

      if (request.method === 'GET') {
        counts = counts && typeof counts === 'object' ? counts : {};
        return new Response(JSON.stringify({ counts }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'POST') {
        const body = await request.json();
        const count = Number(body?.count);

        if (!Number.isInteger(count) || count < 1 || count > 15) {
          return new Response(JSON.stringify({ error: 'Invalid egg count' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        counts = counts && typeof counts === 'object' ? counts : {};
        counts[count] = Number(counts[count] || 0) + 1;

        await env.FAVORITES.put('eggcount', JSON.stringify(counts));

        return new Response(JSON.stringify({ counts }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    const response = await fetch('https://cam.kvitrehus.com/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
