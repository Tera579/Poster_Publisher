// Cloudflare Worker : reçoit le formulaire (JSON) et publie le poster sur GitHub en UN commit.
// Variables à définir dans Cloudflare : GITHUB_TOKEN (secret), GITHUB_REPO, GITHUB_BRANCH,
// ALLOWED_ORIGIN (ex. https://votrecompte.github.io), ACCESS_CODE (optionnel).

const MAX_BYTES = 6 * 1024 * 1024;

class UserError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

const clean = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const cap = (s) => clean(s).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("-");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function gh(env, method, url, body, accept) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: accept || "application/vnd.github+json",
      "User-Agent": "poster-publisher",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function ghJson(env, method, url, body) {
  const r = await gh(env, method, url, body);
  if (!r.ok) throw new Error(`GitHub ${method} ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function readText(env, path, branch) {
  const r = await gh(env, "GET", `/contents/${path}?ref=${encodeURIComponent(branch)}`, null, "application/vnd.github.raw+json");
  return r.ok ? r.text() : null;
}

async function publish(d, env) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) throw new Error("Variables GITHUB_* manquantes");
  const branch = env.GITHUB_BRANCH || "main";
  if (d.bot) throw new UserError("Rejected.");
  if (env.ACCESS_CODE && String(d.code || "").trim() !== env.ACCESS_CODE) throw new UserError("Invalid access code.", 403);

  const nom = String(d.nom || "").trim(), prenom = String(d.prenom || "").trim();
  const email = String(d.email || "").trim(), year = clean(d.annee || ""), confIn = clean(d.conference || "");
  const pdf = String(d.pdf || "");
  if (!nom || !prenom || !confIn || !/^\d{4}$/.test(year)) throw new UserError("Missing or invalid fields.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Invalid e-mail address.");
  if (!pdf.startsWith("JVBERi0")) throw new UserError("The file is not a PDF.");   // "%PDF-" en base64
  if (pdf.length * 0.75 > MAX_BYTES) throw new UserError("The PDF is larger than 6 MB.");

  const first = (await readText(env, "docs/posters.json", branch)) || "[]";
  const known = JSON.parse(first).find((x) => x.conf.toLowerCase() === confIn.toLowerCase());
  const conf = known ? known.conf : confIn.toUpperCase();
  const folder = `${conf}_${year}_${cap(nom)}_${cap(prenom)}`;

  let html = await readText(env, "templates/poster.html", branch);
  if (!html) throw new Error("templates/poster.html introuvable dans le dépôt");
  const vals = { FOLDER: folder, CONF: esc(conf), YEAR: esc(year), NOM: esc(nom), PRENOM: esc(prenom),
    EMAIL: esc(email), NOM_F: cap(nom), PRENOM_F: cap(prenom) };
  for (const [k, v] of Object.entries(vals)) html = html.split(`{${k}}`).join(v);

  const pdfBlob = await ghJson(env, "POST", "/git/blobs", { content: pdf, encoding: "base64" });
  const htmlBlob = await ghJson(env, "POST", "/git/blobs", { content: html, encoding: "utf-8" });

  for (let attempt = 0; attempt < 4; attempt++) {
    const reg = JSON.parse((await readText(env, "docs/posters.json", branch)) || "[]");
    if (reg.some((x) => x.folder.toLowerCase() === folder.toLowerCase()))
      throw new UserError("A poster with the same conference, year and name already exists.", 409);
    const k = reg.find((x) => x.conf.toLowerCase() === conf.toLowerCase());
    reg.push({ conf: k ? k.conf : conf, year: Number(year), nom, prenom, folder, added: new Date().toISOString().slice(0, 10) });
    reg.sort((a, b) => a.conf.localeCompare(b.conf) || a.year - b.year || a.nom.localeCompare(b.nom));
    const regBlob = await ghJson(env, "POST", "/git/blobs", { content: JSON.stringify(reg, null, 2), encoding: "utf-8" });

    const ref = await ghJson(env, "GET", `/git/ref/heads/${branch}`);
    const head = await ghJson(env, "GET", `/git/commits/${ref.object.sha}`);
    const tree = await ghJson(env, "POST", "/git/trees", { base_tree: head.tree.sha, tree: [
      { path: `docs/${folder}/poster.pdf`, mode: "100644", type: "blob", sha: pdfBlob.sha },
      { path: `docs/${folder}/index.html`, mode: "100644", type: "blob", sha: htmlBlob.sha },
      { path: "docs/posters.json", mode: "100644", type: "blob", sha: regBlob.sha } ] });
    const commit = await ghJson(env, "POST", "/git/commits", { message: `Add poster ${folder}`, tree: tree.sha, parents: [ref.object.sha] });
    const upd = await gh(env, "PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha });
    if (upd.ok) return { folder };
    if (upd.status !== 422 && upd.status !== 409) throw new Error(`update ref -> ${upd.status} ${await upd.text()}`);
  }
  throw new Error("Commit conflicts, giving up");
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || "*";
    const cors = { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
    const reply = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply({ ok: false, error: "Method not allowed" }, 405);
    if (allowed !== "*" && request.headers.get("Origin") !== allowed) return reply({ ok: false, error: "Forbidden origin" }, 403);
    try {
      return reply({ ok: true, ...(await publish(await request.json(), env)) });
    } catch (e) {
      if (e instanceof UserError) return reply({ ok: false, error: e.message }, e.status);
      console.error(e);
      // DEBUG=1 (variable Cloudflare) : affiche la vraie cause dans le formulaire. À retirer ensuite.
      return reply({ ok: false, error: env.DEBUG === "1" ? String(e.message).slice(0, 400) : "Server error, please try again later." }, 500);
    }
  },
};
