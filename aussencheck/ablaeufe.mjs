// Nächtliche Ablauf-Tests (seit 2026-11-08) – Ergänzung zum Durchklick.
//
// Prüft je App die wichtigsten Wege, die OHNE Anmeldung gehen (ablaeufe.json):
//   health        /api/health antwortet 200 + JSON mit ok:true bzw. status:"ok",
//                 und kein Unterbefund (befunde.*.ok) ist false
//   geschuetzt    geschützte Seite ohne Sitzung -> Umleitung zur Anmeldung
//                 (3xx auf /login …) oder 401/403; mit "text": 200 zeigt den Login-Text.
//                 200 mit Inhalt = Alarm (Seite wäre offen).
//   discordLogin  Knopf „Mit Discord anmelden“ führt zu discord.com/oauth2/authorize
//                 mit client_id und Rücksprung auf die eigene Domain
//   wall3Login    Knopf „Mit Wall3 anmelden“ (?wall3=1, damit er auch im Modus „test“
//                 erscheint) -> auth.wall3.de/authorize mit client_id + exakter
//                 Rücksprung-Adresse -> weiter zu Discord mit Rücksprung auf
//                 auth.wall3.de/callback. Modus „aus“ = übersprungen, kein Fehler.
//   seite         Seite mit erwarteten Texten (z. B. /verify mit einer Nummer, die es
//                 nicht gibt -> „nicht gefunden“) – gleiche Prüfung wie der Durchklick
//
// Discord selbst wird NIE geladen (Anfragen an discord.com werden abgefangen und
// verworfen), es wird nichts eingegeben, kein Formular mit Zugangsdaten abgeschickt
// (sonst zählte die Login-Meldung des Servers Fehlversuche und sperrte die IP).
// Angemeldete Abläufe gibt es bewusst nicht: In Produktion existiert kein
// Testzugang (Dev-Logins sind nur mit NODE_ENV=development aktiv).

const UA_ZUSATZ = " Wall3-Durchklick/1";
const istOauth = (u) => /\/oauth2\/authorize/.test(u);
const CF = (r) => (r.status === 403 || r.status === 503) && /challenge/i.test(r.headers.get("cf-mitigated") || "");

async function holen(url, ua, umleiten = "manual") {
    return fetch(url, { redirect: umleiten, signal: AbortSignal.timeout(20000), headers: { "user-agent": ua + UA_ZUSATZ, accept: "text/html,application/json" } });
}

function ergebnisVon(a, t0, { status = 0, endUrl = a.url, probleme = [], hinweise = [], cf = false }) {
    return {
        name: a.name, url: a.url, endUrl, status, titel: "", ms: Date.now() - t0,
        ergebnis: cf ? "cf" : probleme.length ? "fehler" : "ok",
        probleme: cf ? [ "Cloudflare-Prüfung statt Antwort – übersprungen" ] : [ ...new Set(probleme) ],
        hinweise: [ ...new Set(hinweise) ].slice(0, 3), bild: null, trace: null,
    };
}

async function health(a, ua) {
    const t0 = Date.now();
    const r = await holen(a.url, ua, "follow");
    if (CF(r)) return ergebnisVon(a, t0, { status: r.status, cf: true });
    const probleme = [];
    if (r.status !== 200) probleme.push(`HTTP ${r.status}`);
    let j = null;
    try { j = await r.json(); } catch { probleme.push("Antwort ist kein JSON"); }
    if (j) {
        if (!(j.ok === true || j.status === "ok")) probleme.push("Health meldet nicht ok");
        for (const [ k, v ] of Object.entries(j.befunde || {})) if (v && v.ok === false) probleme.push(`Befund „${k}“ nicht ok${v.hinweis ? ": " + String(v.hinweis).slice(0, 80) : ""}`);
    }
    return ergebnisVon(a, t0, { status: r.status, endUrl: r.url, probleme });
}

async function geschuetzt(a, ua) {
    const t0 = Date.now();
    const r = await holen(a.url, ua);
    if (CF(r)) return ergebnisVon(a, t0, { status: r.status, cf: true });
    const probleme = [];
    const loginMuster = new RegExp(a.ziel || "/login", "i");
    let endUrl = a.url;
    if (r.status >= 300 && r.status < 400) {
        const ort = new URL(r.headers.get("location") || "", a.url);
        endUrl = ort.href;
        if (ort.host !== new URL(a.url).host) probleme.push(`Umleitung auf fremde Domain: ${ort.host}`);
        else if (!loginMuster.test(ort.pathname)) probleme.push(`Umleitung nicht zur Anmeldung, sondern nach ${ort.pathname}`);
    } else if (r.status === 401 || r.status === 403) {
        // ok: abgewiesen
    } else if (r.status === 200 && a.text) {
        const html = await r.text();
        if (!html.toLowerCase().includes(a.text.toLowerCase())) probleme.push(`ohne Anmeldung erreichbar, Login-Text „${a.text}“ fehlt`);
    } else if (r.status === 200) {
        probleme.push("ohne Anmeldung erreichbar (200 statt Umleitung zur Anmeldung)");
    } else {
        probleme.push(`HTTP ${r.status}`);
    }
    return ergebnisVon(a, t0, { status: r.status, endUrl, probleme });
}

/** Öffnet die Login-Seite, klickt den Knopf und sammelt die Ziele (auth.wall3.de, discord.com). */
async function klicken(browser, a, ua, knopf, ergaenzung) {
    const ctx = await browser.newContext({ locale: "de-DE", viewport: { width: 1280, height: 860 }, userAgent: ua + UA_ZUSATZ });
    const discord = [], auth = [];
    const oauth = istOauth;
    // Discord nie laden: Seitenaufrufe folgen den Umleitungen hier selbst (Schritt für
    // Schritt) – zeigt eine auf discord.com, wird nur das Ziel gemerkt und abgebrochen.
    // (Ein route() nur auf discord.com reicht nicht: Umleitungen, denen der Browser
    // folgt, laufen an route() vorbei – dann lüde Discord doch.)
    const istDiscord = (u) => u.hostname === "discord.com" || u.hostname.endsWith(".discord.com");
    const merke = (u) => { if (u.hostname === "auth.wall3.de") auth.push(u.href); };
    await ctx.route(() => true, async (route) => {
        const rq = route.request();
        let ziel = new URL(rq.url());
        if (istDiscord(ziel)) { discord.push(ziel.href); return route.abort(); }
        if (!rq.isNavigationRequest()) return route.continue();
        let antwort = null;
        for (let schritt = 0; schritt < 8; schritt++) {
            merke(ziel);
            antwort = await route.fetch(schritt === 0 ? { maxRedirects: 0 } : { url: ziel.href, method: "GET", maxRedirects: 0 }).catch(() => null);
            if (!antwort) return route.abort();
            const ort = antwort.headers()["location"];
            if (!(antwort.status() >= 300 && antwort.status() < 400 && ort)) break;
            ziel = new URL(ort, ziel);
            if (istDiscord(ziel)) { discord.push(ziel.href); return route.abort(); }
        }
        return route.fulfill({ response: antwort });
    });
    const page = await ctx.newPage();
    let status = 0, titel = "", text = "", fehler = null;
    try {
        const antwort = await page.goto(a.url, { waitUntil: "load", timeout: 30000 });
        status = antwort ? antwort.status() : 0;
        titel = await page.title().catch(() => "");
        const k = page.getByText(knopf, { exact: false }).filter({ visible: true }).first();
        const da = await k.waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
        if (da) {
            await k.click({ timeout: 10000, noWaitAfter: true }).catch((e) => { fehler = "Klick: " + e.message.split("\n")[0].slice(0, 100); });
            const bis = Date.now() + 15000;
            while (!discord.some(oauth) && Date.now() < bis) await page.waitForTimeout(250);
            // NextAuth (scba): erst eine eigene Anmeldeseite mit „Sign in with Discord“
            if (!discord.some(oauth) && ergaenzung) {
                const zweit = page.getByRole("button", { name: /discord/i }).first();
                if (await zweit.isVisible().catch(() => false)) {
                    await zweit.click({ timeout: 10000, noWaitAfter: true }).catch(() => {});
                    const bis2 = Date.now() + 10000;
                    while (!discord.some(oauth) && Date.now() < bis2) await page.waitForTimeout(250);
                }
            }
        }
        text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
        return { da, status, titel, text, discord, auth, fehler, endUrl: page.url(), page, ctx };
    } catch (e) {
        return { da: false, status, titel, text, discord, auth, fehler: "lädt nicht: " + e.message.split("\n")[0].slice(0, 120), endUrl: page.url(), page, ctx };
    }
}

function discordZiel(url) {
    const u = new URL(url);
    return { pfadOk: /\/oauth2\/authorize$/.test(u.pathname), clientId: u.searchParams.get("client_id"), rueck: u.searchParams.get("redirect_uri") };
}

async function abschliessen(k, a, t0, probleme, hinweise, bilder) {
    // Cloudflare-Abfrage statt Login-Seite: wie beim Durchklick übersprungen, kein Fehler
    const cf = probleme.length > 0 && /Just a moment\.\.\.|Verifying you are human|Checking your browser|Attention Required!/i.test(`${k.titel}\n${k.text.slice(0, 2000)}`);
    let bild = null;
    if (probleme.length && bilder && !cf) {
        bild = `${bilder}/${a.name.replace(/[^\w.-]+/g, "_")}.png`;
        await k.page.screenshot({ path: bild, timeout: 15000 }).catch(() => { bild = null; });
    }
    await k.ctx.close().catch(() => {});
    const r = ergebnisVon(a, t0, { status: k.status, endUrl: k.endUrl, probleme, hinweise, cf });
    r.titel = k.titel; r.bild = bild;
    return r;
}

async function discordLogin(browser, a, ua, bilder) {
    const t0 = Date.now();
    const k = await klicken(browser, a, ua, a.knopf || "Mit Discord anmelden", true);
    const probleme = [], hinweise = [];
    if (k.fehler) probleme.push(k.fehler);
    const ziel = k.discord.find(istOauth);
    if (!k.da) probleme.push(`Knopf „${a.knopf || "Mit Discord anmelden"}“ fehlt`);
    else if (!ziel) probleme.push("Klick führt nicht zu Discord (oauth2/authorize)");
    else {
        const d = discordZiel(ziel);
        const host = a.rueckHost || new URL(a.url).host;
        if (!d.pfadOk) probleme.push("Discord-Ziel ist nicht /oauth2/authorize");
        if (!d.clientId) probleme.push("client_id fehlt");
        if (!d.rueck) probleme.push("redirect_uri fehlt");
        else if (new URL(d.rueck).host !== host) probleme.push(`Rücksprung auf ${new URL(d.rueck).host} statt ${host}`);
    }
    return abschliessen(k, a, t0, probleme, hinweise, bilder);
}

async function wall3Login(browser, a, ua, bilder) {
    const t0 = Date.now();
    const k = await klicken(browser, a, ua, "Mit Wall3 anmelden", false);
    const probleme = [], hinweise = [];
    const origin = new URL(a.url).origin;
    const aus = /ausgeschaltet|wall3_aus/i.test(k.text + " " + k.endUrl);
    if (k.fehler) probleme.push(k.fehler);
    if (!k.da || (aus && !k.auth.length)) {
        // Knopf fehlt bzw. Weg aus: nur ein Fehler, wenn die Start-Route trotzdem zu auth.wall3.de führt
        let aktiv = false;
        try {
            const r = await holen(`${origin}/api/auth/wall3/start`, ua);
            aktiv = /^https:\/\/auth\.wall3\.de\/authorize/.test(r.headers.get("location") || "");
        } catch { /* nicht erreichbar -> unten als Fehler */ }
        if (aktiv && !k.da) probleme.push("Knopf „Mit Wall3 anmelden“ fehlt, obwohl die Wall3-Anmeldung aktiv ist");
        else if (!aktiv) hinweise.push("Wall3-Anmeldung für diese App ausgeschaltet – übersprungen");
    } else {
        const authorize = k.auth.map((u) => new URL(u)).find((u) => u.pathname === "/authorize");
        if (!authorize) probleme.push("Klick führt nicht zu auth.wall3.de/authorize");
        else {
            if (a.client && authorize.searchParams.get("client_id") !== a.client) probleme.push(`client_id „${authorize.searchParams.get("client_id")}“ statt „${a.client}“`);
            const soll = `${origin}/api/auth/wall3/callback`;
            if (authorize.searchParams.get("redirect_uri") !== soll) probleme.push(`redirect_uri „${authorize.searchParams.get("redirect_uri")}“ statt „${soll}“`);
            if (authorize.searchParams.get("code_challenge_method") !== "S256") probleme.push("kein PKCE (S256)");
            if (!authorize.searchParams.get("state")) probleme.push("state fehlt");
        }
        const ziel = k.discord.find(istOauth);
        if (!ziel) {
            // auth.wall3.de zeigt evtl. eine eigene Seite (Fehler, Wartung) statt weiterzuleiten
            if (authorize) probleme.push(`auth.wall3.de leitet nicht zu Discord weiter (zeigt: ${k.titel || k.text.slice(0, 60).replace(/\s+/g, " ")})`);
        } else {
            const d = discordZiel(ziel);
            if (d.rueck !== "https://auth.wall3.de/callback") probleme.push(`Discord-Rücksprung „${d.rueck}“ statt https://auth.wall3.de/callback`);
        }
    }
    return abschliessen(k, a, t0, probleme, hinweise, bilder);
}

/** Führt einen Ablauf aus; "seite" erledigt der Durchklick selbst (pruefeSeite). */
export async function pruefeAblauf(browser, a, ua, { bilder, pruefeSeite }) {
    try {
        switch (a.art) {
            case "health": return await health(a, ua);
            case "geschuetzt": return await geschuetzt(a, ua);
            case "discordLogin": return await discordLogin(browser, a, ua, bilder);
            case "wall3Login": return await wall3Login(browser, a, ua, bilder);
            case "seite": return await pruefeSeite(browser, a);
            default: return ergebnisVon(a, Date.now(), { probleme: [ `unbekannte Art „${a.art}“` ] });
        }
    } catch (e) {
        return ergebnisVon(a, Date.now(), { probleme: [ "Ablauf abgebrochen: " + String(e?.message || e).split("\n")[0].slice(0, 140) ] });
    }
}
