/**
 * Naghedi Warehouse — Airtable sync relay (Cloudflare Worker)
 * --------------------------------------------------------------
 * Keeps your Airtable token OUT of the web app. The app calls THIS worker;
 * the worker is the only thing that holds your Airtable credentials.
 *
 * Endpoints (any path works):
 *   GET   ->  returns { state: <your saved layout> }   (or { state: null } if none yet)
 *   PUT   ->  body { state: {...} }  saves the layout
 *
 * Required Worker variables / secrets (set in the Cloudflare dashboard):
 *   AIRTABLE_TOKEN  (Secret)  Personal Access Token, scoped to ONLY the new base
 *   BASE_ID         (Var)     the base id, looks like  app XXXXXXXXXXXXXX
 *   SECRET          (Secret)  any password you choose; you paste the same one into the app
 * Optional (defaults shown):
 *   TABLE   = "Layout"
 *   KEY_VALUE = "warehouse"
 *
 * The "Layout" table needs two fields:  Key (single line text, primary) and State (long text).
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-secret",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // shared-secret gate
    if ((request.headers.get("x-secret") || "") !== env.SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const TABLE = env.TABLE || "Layout";
    const KEY = env.KEY_VALUE || "warehouse";
    const api = `https://api.airtable.com/v0/${env.BASE_ID}/${encodeURIComponent(TABLE)}`;
    const auth = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };

    try {
      // find the single layout record
      const findUrl = `${api}?maxRecords=1&filterByFormula=${encodeURIComponent(`{Key}='${KEY}'`)}`;
      const found = await (await fetch(findUrl, { headers: auth })).json();
      const rec = (found.records || [])[0];

      if (request.method === "GET") {
        let state = null;
        if (rec && rec.fields && rec.fields.State) {
          try { state = JSON.parse(rec.fields.State); } catch (e) { state = null; }
        }
        return json({ state });
      }

      if (request.method === "PUT") {
        const body = await request.json();
        const state = body && body.state ? body.state : body;
        const fields = { Key: KEY, State: JSON.stringify(state) };

        let res;
        if (rec) {
          res = await fetch(`${api}/${rec.id}`, {
            method: "PATCH",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ fields }),
          });
        } else {
          res = await fetch(api, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ records: [{ fields }] }),
          });
        }
        if (!res.ok) return json({ error: "airtable " + res.status, detail: await res.text() }, 502);
        return json({ ok: true });
      }

      return json({ error: "method not allowed" }, 405);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
