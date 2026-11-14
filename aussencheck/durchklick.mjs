// Durchklick-Prüfung (seit 2026-10-30): öffnet die öffentlichen Start- bzw.
// Login-Seiten mit einem ECHTEN Browser (Chrome des GitHub-Rechners über
// playwright-core) und prüft, ob sie richtig AUSSEHEN – nicht nur, ob 200 kommt:
//   - erwartete Texte sichtbar (seiten.json → "texte"), optional ein Element ("element")
//   - keine Fehlerseite (Next-/Caddy-/Cloudflare-Fehler, Wartungsseite, HTTP >= 400)
//   - keine Skriptfehler, die die Seite brechen (pageerror, ChunkLoadError, Hydration)
//   - CSS geladen: alle Stylesheets 2xx, Regeln vorhanden, Schrift nicht Browser-Standard,
//     und Tailwind lebt: ein Element mit NUR "hidden" (ohne md:/xl:-Variante) ist unsichtbar
//     (genau das bricht, wenn `next build` neben einem laufenden Dev-Server die .next-CSS zerlegt)
//
// Zweimal hintereinander: was beim ersten Durchgang auffällt, wird nach WARTE_S
// Sekunden erneut geprüft. Erst wenn es dann noch kaputt ist, gilt es als Fehler
// (kein Fehlalarm durch kurze Neustarts). Cloudflare-Abfragen ("Just a moment")
// zählen NICHT als Fehler, sondern werden als "von Cloudflare geprüft" gemeldet –
// Regeln werden dafür nicht gelockert.
//
// Nachts (DURCHKLICK_ABLAEUFE=1, im Außencheck um 02:xx UTC) zusätzlich die Ablauf-Tests aus
// ablaeufe.json (ablaeufe.mjs): Health, geschützte Seiten -> Login, Discord-/Wall3-Login-Start,
// /verify – gleiche zwei Durchgänge, gleiche Kuma-Meldung.
//
// Meldung: Kuma-Push-Monitor "Durchklick (außen)" (Adresse im Secret DURCHKLICK_PUSH),
// Bildschirmfotos + Playwright-Traces der Fehler in bilder/ (nur lokal – das Repo ist öffentlich, kein Artefakt),
// Tabelle in der Lauf-Zusammenfassung. Der Lauf selbst schlägt nur fehl, wenn das
// Skript abstürzt – Seitenfehler meldet Kuma (sonst käme jede Störung als GitHub-Mail).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HIER = path.dirname(fileURLToPath(import.meta.url));
// DURCHKLICK_NUR=<regex> prueft nur passende Seiten; DURCHKLICK_TEST_OHNE_CSS=1 blockiert alle
// Stylesheets (Selbsttest: dann muss jede Seite als "CSS fehlt" auffallen).
const SEITEN = JSON.parse(fs.readFileSync(path.join(HIER, "seiten.json"), "utf8")).seiten
    .filter((s) => !process.env.DURCHKLICK_NUR || new RegExp(process.env.DURCHKLICK_NUR, "i").test(s.name));
const nurFilter = (s) => !process.env.DURCHKLICK_NUR || new RegExp(process.env.DURCHKLICK_NUR, "i").test(s.name);
// Ablauf-Tests nur auf Wunsch; deploy.mjs kopiert nur durchklick.mjs + seiten.json -> Datei darf fehlen
const MIT_ABLAEUFEN = process.env.DURCHKLICK_ABLAEUFE === "1" && fs.existsSync(path.join(HIER, "ablaeufe.json"));
const ABLAEUFE = MIT_ABLAEUFEN ? JSON.parse(fs.readFileSync(path.join(HIER, "ablaeufe.json"), "utf8")).ablaeufe.filter(nurFilter) : [];
const pruefeAblauf = MIT_ABLAEUFEN ? (await import("./ablaeufe.mjs")).pruefeAblauf : null;
const BILDER = path.join(HIER, "bilder");
const WARTE_S = Number(process.env.DURCHKLICK_WARTE_S || 75);
const GLEICHZEITIG = 6;
// So lange wartet jede Text-/Element-Pruefung, bis es sichtbar ist (clientseitig gerenderte Seiten).
const SICHTBAR_MS = Number(process.env.DURCHKLICK_SICHTBAR_MS || 10000);
const PUSH = process.env.DURCHKLICK_PUSH || "";
const UA_ZUSATZ = " Wall3-Durchklick/1";

fs.mkdirSync(BILDER, { recursive: true });

const FEHLERSEITE = [
    [/Application error: a (client|server)-side exception/i, "Next: Anwendungsfehler"],
    [/This page could not be found|404: This page/i, "Next: 404"],
    [/Internal Server Error/i, "Internal Server Error"],
    [/502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out/i, "Proxy-Fehler"],
    [/Web server is down|Connection timed out|Bad gateway.*Cloudflare|Error 52\d/i, "Cloudflare: Server nicht erreichbar"],
    [/Kurz nicht erreichbar|Vorübergehend nicht erreichbar/i, "Wartungs-/Notfallseite"],
];
const CF_PRUEFUNG = /Just a moment\.\.\.|Verifying you are human|Checking your browser|Attention Required!.*Cloudflare|cf-chl-|challenge-platform/i;
const BRICHT = /ChunkLoadError|Loading chunk .* failed|Hydration failed|Minified React error|There was an error while hydrating|Cannot read properties of (undefined|null)|is not a function|is not defined/i;

async function pruefe(browser, s) {
    const ctx = await browser.newContext({
        locale: "de-DE",
        viewport: { width: 1280, height: 860 },
        // Ehrlich bleiben: HeadlessChrome bleibt im User-Agent stehen (kein Umgehen des
        // Bot-Schutzes), dazu die eigene Kennung fuer das Zugriffsprotokoll.
        userAgent: UA + UA_ZUSATZ,
    });
    if (process.env.DURCHKLICK_TEST_OHNE_CSS) await ctx.route((u) => u.pathname.endsWith(".css") || u.hostname === "fonts.googleapis.com", (r) => r.abort());
    // Playwright-Trace (seit 2026-11-02): laeuft immer mit, gespeichert wird er nur bei
    // einem Befund (bilder/<Seite>.trace.zip, Workflow laedt ihn als Artefakt hoch).
    // Ansehen: npx playwright show-trace <datei>.trace.zip oder https://trace.playwright.dev
    await ctx.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
    const page = await ctx.newPage();
    const probleme = [], hinweise = [];
    const cssFehler = [];
    // Nur Fehler aus EIGENEM Code zaehlen (eigene Domain bzw. /_next/): Skripte Dritter
    // (Analytics, Cloudflare-Insights, Browser-Erweiterungen …) sind nur ein Hinweis.
    const basis = new URL(s.url).hostname.split(".").slice(-2).join(".");
    const eigen = (u) => {
        if (!u) return false;
        if (u.includes("/_next/")) return true;
        try { const h = new URL(u).hostname; return h === basis || h.endsWith("." + basis); } catch { return false; }
    };
    page.on("pageerror", (e) => {
        const zeile = "Skriptfehler: " + e.message.split("\n")[0].slice(0, 140);
        const herkunft = String(e.stack || "").match(/https?:\/\/[^\s)]+/g) || [];
        if (herkunft.some(eigen)) probleme.push(zeile);
        else hinweise.push(zeile + (herkunft.length ? ` (fremd: ${new URL(herkunft[0]).hostname})` : " (Herkunft unbekannt)"));
    });
    page.on("console", (m) => {
        if (m.type() !== "error") return;
        const t = m.text();
        const vonUns = eigen(m.location()?.url);
        if (BRICHT.test(t) && vonUns) probleme.push("Konsole: " + t.split("\n")[0].slice(0, 140));
        else if (!/Failed to load resource/i.test(t)) hinweise.push("Konsole" + (vonUns ? "" : " (fremd)") + ": " + t.split("\n")[0].slice(0, 100));
    });
    page.on("response", (r) => {
        const typ = r.request().resourceType();
        if (typ === "stylesheet" && r.status() >= 400 && eigen(r.url())) cssFehler.push(`${r.status()} ${new URL(r.url()).pathname.slice(0, 60)}`);
        if (typ === "script" && r.status() >= 400 && r.url().includes("/_next/")) probleme.push(`Skript ${r.status()}: ${new URL(r.url()).pathname.slice(0, 60)}`);
    });
    const t0 = Date.now();
    let status = 0, endUrl = s.url, titel = "", ergebnis = "ok";
    try {
        const antwort = await page.goto(s.url, { waitUntil: "load", timeout: 30000 });
        status = antwort ? antwort.status() : 0;
        // Kein "networkidle" mehr (seit 2026-11-02): offene Verbindungen (Analytics,
        // Websockets, Polling) liessen es still nach 6 s abbrechen, und clientseitig
        // gerenderte Seiten waren dann oft noch leer -> Fehlalarm "Text fehlt". Stattdessen
        // wartet unten jede Pruefung gezielt, bis ihr Text/Element sichtbar ist.
        // Seiten, die clientseitig weiterleiten (z. B. Informanten-Portal: / ->
        // /informant/login), zerstoeren den Kontext mitten im Lesen ("Execution
        // context was destroyed") – das war bei jedem Deploy ein Fehlalarm. Dann
        // auf das Ende der Navigation warten und erneut lesen.
        const lesen = async () => {
            for (let versuch = 1; ; versuch++) {
                try {
                    return {
                        titel: await page.title(),
                        text: await page.evaluate(() => document.body ? document.body.innerText : ""),
                    };
                } catch (e) {
                    if (versuch >= 4 || !/context was destroyed|navigat/i.test(String(e?.message))) throw e;
                    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
                }
            }
        };
        let jetzt = await lesen();
        const html = (await page.content()).slice(0, 20000);

        if (CF_PRUEFUNG.test(jetzt.titel + "\n" + jetzt.text.slice(0, 2000)) || (status === 403 && /cloudflare/i.test(html) && /challenge|cf-chl|ray id/i.test(html))) {
            ergebnis = "cf";
            probleme.push("Cloudflare-Prüfung statt Seite (Bot-Schutz/WAF) – übersprungen");
        } else {
            if (status >= 400) probleme.push(`HTTP ${status}`);
            // Auf jeden erwarteten Text/jedes Element bis zu 10 s warten (bricht sofort ab,
            // sobald es da ist). filter({ visible }) vor first(): sonst koennte ein
            // verstecktes Duplikat (z. B. Mobil-Menue) das sichtbare verdecken.
            const sichtbar = (loc) => loc.filter({ visible: true }).first().waitFor({ state: "visible", timeout: SICHTBAR_MS }).then(() => true, () => false);
            for (const t of s.texte || []) {
                if (!(await sichtbar(page.getByText(t, { exact: false })))) probleme.push(`Text fehlt: „${t}“`);
            }
            if (s.element && !(await sichtbar(page.locator(s.element)))) probleme.push(`Element fehlt: ${s.element}`);
            // Fehlerseiten erst NACH dem Warten pruefen – Next zeigt „Application error“
            // erst, wenn das Rendern im Browser gescheitert ist.
            jetzt = await lesen();
            for (const [ muster, name ] of FEHLERSEITE) if (muster.test(jetzt.titel + "\n" + jetzt.text.slice(0, 3000))) probleme.push("Fehlerseite: " + name);
            if (/Wartungsarbeiten/i.test(jetzt.titel)) probleme.push("Fehlerseite: Wartungsseite (Dienst antwortet nicht)");
            // CSS
            const css = await page.evaluate(() => {
                let regeln = 0, blaetter = 0;
                for (const b of document.styleSheets) { blaetter++; try { regeln += b.cssRules.length; } catch { regeln += 1; } }
                const schrift = getComputedStyle(document.body).fontFamily;
                const nurHidden = [ ...document.querySelectorAll(".hidden") ].filter((e) => ![ ...e.classList ].some((c) => c.includes(":")));
                const sichtbarTrotzHidden = nurHidden.filter((e) => getComputedStyle(e).display !== "none").length;
                return { regeln, blaetter, schrift, nurHidden: nurHidden.length, sichtbarTrotzHidden };
            });
            if (cssFehler.length) probleme.push("CSS lädt nicht: " + cssFehler.slice(0, 2).join(", "));
            if (css.regeln < (s.minRegeln ?? 20)) probleme.push(`CSS fehlt (nur ${css.regeln} Regeln in ${css.blaetter} Stylesheets)`);
            if (/^"?Times New Roman"?$|^serif$/i.test(css.schrift.trim()) && !s.serifErlaubt) probleme.push("CSS fehlt: Seite in Browser-Standardschrift");
            if (css.sichtbarTrotzHidden) probleme.push(`CSS kaputt: ${css.sichtbarTrotzHidden} „hidden“-Element(e) sichtbar (Tailwind-Klassen fehlen)`);
        }
    } catch (e) {
        probleme.push("lädt nicht: " + e.message.split("\n")[0].slice(0, 140));
    }
    try { endUrl = page.url(); titel = await page.title(); } catch { /* Seite schon weg */ }
    const ms = Date.now() - t0;
    if (probleme.length && ergebnis !== "cf") ergebnis = "fehler";
    let bild = null, trace = null;
    const dateiname = s.name.replace(/[^\w.-]+/g, "_");
    if (ergebnis !== "ok") {
        bild = path.join(BILDER, dateiname + ".png");
        await page.screenshot({ path: bild, fullPage: false, timeout: 15000 }).catch(() => { bild = null; });
    }
    if (ergebnis === "fehler") {
        trace = path.join(BILDER, dateiname + ".trace.zip");
        await ctx.tracing.stop({ path: trace }).catch(() => { trace = null; });
    } else {
        await ctx.tracing.stop().catch(() => {});
    }
    await ctx.close();
    return { name: s.name, url: s.url, endUrl, status, titel, ergebnis, probleme: [ ...new Set(probleme) ], hinweise: [ ...new Set(hinweise) ].slice(0, 3), ms, bild, trace };
}

async function alle(browser, liste) {
    const aus = new Array(liste.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(GLEICHZEITIG, liste.length) }, async () => {
        while (i < liste.length) {
            const k = i++;
            aus[k] = liste[k].art
                ? await pruefeAblauf(browser, liste[k], UA, { bilder: BILDER, pruefeSeite: pruefe })
                : await pruefe(browser, liste[k]);
        }
    }));
    return aus;
}

async function kuma(ok, text, ms) {
    if (!PUSH) { console.log("(kein DURCHKLICK_PUSH – keine Kuma-Meldung)"); return; }
    const msg = encodeURIComponent(text.replace(/\s+/g, " ").slice(0, 240));
    try {
        const r = await fetch(`${PUSH}?status=${ok ? "up" : "down"}&msg=${msg}&ping=${ms}`, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "Wall3-Durchklick/1" } });
        console.log("Kuma:", r.status);
    } catch (e) { console.log("Kuma nicht erreichbar:", e.message); }
}

const start = Date.now();
const browser = await chromium.launch({ channel: process.env.DURCHKLICK_KANAL || "chrome", headless: true });
const UA = await browser.newPage().then(async (p) => { const u = await p.evaluate(() => navigator.userAgent); await p.close(); return u; });
const LISTE = [ ...SEITEN, ...ABLAEUFE ];
if (MIT_ABLAEUFEN) console.log(`mit ${ABLAEUFE.length} Ablauf-Tests`);
let erst = await alle(browser, LISTE);
const auffaellig = erst.filter((r) => r.ergebnis !== "ok");
let zweit = [];
if (auffaellig.length) {
    console.log(`${auffaellig.length} auffällig – zweiter Durchgang in ${WARTE_S} s: ${auffaellig.map((r) => r.name).join(", ")}`);
    await new Promise((ja) => setTimeout(ja, WARTE_S * 1000));
    zweit = await alle(browser, LISTE.filter((s) => auffaellig.some((r) => r.name === s.name)));
}
await browser.close();

const endgueltig = erst.map((r) => zweit.find((z) => z.name === r.name) || r);
// Ein Wackler (1. Durchgang kaputt, 2. ok) hinterlaesst kein Bild und keinen Trace
for (const r of erst) if (endgueltig.find((x) => x.name === r.name)?.ergebnis === "ok") for (const f of [ r.bild, r.trace ]) if (f) fs.rmSync(f, { force: true });
const fehler = endgueltig.filter((r) => r.ergebnis === "fehler");
const cf = endgueltig.filter((r) => r.ergebnis === "cf");
const wackler = erst.filter((r) => r.ergebnis !== "ok" && endgueltig.find((x) => x.name === r.name)?.ergebnis === "ok");

const sum = [ MIT_ABLAEUFEN ? `## Durchklick + Ablauf-Tests (${SEITEN.length} Seiten, ${ABLAEUFE.length} Abläufe)` : "## Durchklick (echter Browser)", "", `${endgueltig.length - fehler.length - cf.length}/${endgueltig.length} ok` +
    (fehler.length ? ` · **${fehler.length} kaputt**` : "") + (cf.length ? ` · ${cf.length} von Cloudflare geprüft (übersprungen)` : "") + (wackler.length ? ` · ${wackler.length} nur kurz gestört` : ""), "",
    "| Seite | Ergebnis | HTTP | Zeit | Befund |", "|---|---|---|---|---|" ];
for (const r of endgueltig) {
    const w = wackler.some((x) => x.name === r.name) ? " (1. Versuch: " + erst.find((x) => x.name === r.name).probleme.join("; ") + ")" : "";
    sum.push(`| ${r.name} | ${r.ergebnis === "ok" ? "ok" : r.ergebnis === "cf" ? "Cloudflare" : "**FEHLER**"} | ${r.status} | ${(r.ms / 1000).toFixed(1)} s | ${(r.probleme.join("; ") || r.hinweise.join("; ")).replace(/\|/g, "/")}${w} |`);
}
// Laeuft im Hintergrund neben der curl-Pruefung (spart eine Abrechnungsminute) - die
// Zusammenfassung haengt der Schritt "Durchklick (Ergebnis)" an.
fs.writeFileSync(path.join(HIER, "zusammenfassung.md"), sum.join("\n") + "\n");
console.log(sum.join("\n"));
fs.writeFileSync(path.join(BILDER, "ergebnis.json"), JSON.stringify({ zeit: new Date().toISOString(), erst, endgueltig }, null, 1));

const kurz = (r) => `${r.name}: ${r.probleme[0] || "?"}`;
const text = fehler.length
    ? `${fehler.length} Seite(n) kaputt (2x geprüft): ${fehler.map(kurz).join(" | ")}`
    : `${endgueltig.length - cf.length}/${endgueltig.length} ${MIT_ABLAEUFEN ? "Seiten + Abläufe" : "Seiten"} ok` + (cf.length ? ` · Cloudflare prüft: ${cf.map((r) => r.name).join(", ")}` : "") + (wackler.length ? ` · kurz gestört: ${wackler.map((r) => r.name).join(", ")}` : "");
await kuma(!fehler.length, text, Date.now() - start);
