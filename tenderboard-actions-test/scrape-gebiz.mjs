// GeBIZ opportunity crawler.
//
// GeBIZ publishes RSS for only a handful of procurement categories and those
// feeds are near-empty: an audit on 11 Sep 2026 found 10 live feeds carrying
// 23 tenders between them, with IT Services & Software Development empty. The
// site itself listed 619 open opportunities the same day. This reads the site.
//
// Selectors come from a diagnostic run against the live page, not guesswork:
//
//   link   /ptn/opportunity/directlink.xhtml?docCode=HLTHQ0ETT26000037
//   row    Tender - HLTHQ0ETT26000037 / MOH ITT B08/26 OPEN <title>
//          Agency <agency>
//          Published 11 Sep 2026 04:20 PM
//          Procurement Category Construction ⇒ Others
//          Closing on 12 Oct 2026 04:00PM
//
// Fields are read by their labels rather than by position or CSS class, so a
// restyle of the page does not silently start returning wrong columns.

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const entryUrls = [
  "https://www.gebiz.gov.sg/ptn/opportunity/index.xhtml",
  "https://www.gebiz.gov.sg/ptn/opportunity/BOListing.xhtml?origin=menu",
];
const output = "GeBIZ_Raw_latest.csv";
const statusOutput = "GeBIZ_Raw_status.json";
const diagnosticOutput = "GeBIZ_Raw_diagnostic.txt";
const maxPages = 40;
// The tracker collects daily, so a week's overlap is ample insurance against a
// missed run without walking the whole 619-row list every morning.
const maxAgeDays = 7;

const csvCell = (value = "") => `"${String(value).replaceAll('"', '""')}"`;
const sgtNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
const sgtStamp = () =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Singapore",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date()).replace(" ", "T") + "+08:00";

// "11 Sep 2026 04:20 PM" and "12 Oct 2026 04:00PM" both appear on the page.
const parseListingDate = (raw) => {
  const match = String(raw || "").trim()
    .match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (!match) return null;
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const month = months.indexOf(match[2].toLowerCase());
  if (month < 0) return null;
  let hour = Number(match[4] || 0);
  if (/pm/i.test(match[6] || "") && hour < 12) hour += 12;
  if (/am/i.test(match[6] || "") && hour === 12) hour = 0;
  return new Date(Number(match[3]), month, Number(match[1]), hour, Number(match[5] || 0));
};

// Runs inside the page. Everything it needs must be defined here.
const extractRows = () => {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  // Expand upward while the ancestor still contains exactly one opportunity
  // link: that is the largest element guaranteed to be a single listing, so it
  // captures the header ("Tender - REF / AGENCY REF OPEN") and the trailing
  // closing date as well as the labelled middle. Testing for label presence
  // instead stops at an inner block and silently loses both ends.
  const rowOf = (anchor) => {
    let node = anchor.parentElement;
    let best = anchor.parentElement;
    for (let depth = 0; node && depth < 12; depth += 1) {
      if (node.querySelectorAll('a[href*="docCode="]').length > 1) break;
      best = node;
      node = node.parentElement;
    }
    return best;
  };

  // Text between one label and the next, which is how the row is structured.
  const between = (text, start, end) => {
    const from = text.indexOf(start);
    if (from < 0) return "";
    const rest = text.slice(from + start.length);
    const to = end ? rest.indexOf(end) : -1;
    return clean(to < 0 ? rest : rest.slice(0, to));
  };

  const anchors = Array.from(document.querySelectorAll('a[href*="docCode="]'));
  const rows = anchors.map((anchor) => {
    const href = anchor.href || "";
    const code = (href.match(/[?&]docCode=([^&]+)/i) || [])[1] || "";
    const row = rowOf(anchor);
    const text = clean(row ? row.innerText : anchor.textContent);

    // "Tender - REF / SECONDARY OPEN Title..." — the type and reference sit
    // ahead of the status word, the title after it.
    const head = between(text, "", "Agency ");
    const typeMatch = head.match(/\b(Tender Lite|Tender|Quotation|EOI|Expression of Interest|Request for Information|RFI)\b\s*-/i);
    const statusMatch = head.match(/\b(OPEN|CLOSED|AWARDED|CANCELLED)\b/i);
    const title = statusMatch
      ? clean(head.slice(head.indexOf(statusMatch[0]) + statusMatch[0].length))
      : clean(anchor.textContent);

    // The whole reference block, which may carry the agency's own number after
    // a slash — "HLTHQ0ETT26000037 / MOH ITT B08/26". Split on the slash and
    // the secondary's own slashes break it, so take it intact; that also
    // matches how references are already written in MANUAL_TENDERS.
    const refBlock = clean((head.match(/-\s*(.+?)\s+(?:OPEN|CLOSED|AWARDED|CANCELLED)\b/i) || [])[1] || "");
    return {
      reference: code ? decodeURIComponent(code) : "",
      fullReference: refBlock || (code ? decodeURIComponent(code) : ""),
      type: typeMatch ? clean(typeMatch[1]) : "",
      status: statusMatch ? clean(statusMatch[1]).toUpperCase() : "OPEN",
      title,
      agency: between(text, "Agency ", "Published "),
      published: between(text, "Published ", "Procurement Category "),
      category: between(text, "Procurement Category ", "Closing on "),
      closing: clean((between(text, "Closing on ", "")
        .match(/^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?/i) || [])[0] || ""),
      link: href,
      rowText: text,
    };
  });

  return {
    rows: rows.filter((row) => row.title && row.reference),
    diagnostic: {
      pageTitle: document.title,
      notFound: /page not found/i.test(document.title || ""),
      anchorsWithDocCode: anchors.length,
      totalAnchors: document.querySelectorAll("a").length,
      sampleHrefs: Array.from(document.querySelectorAll("a"))
        .map((a) => a.getAttribute("href") || "")
        .filter((href) => href.indexOf("docCode=") >= 0).slice(0, 5),
      bodyText: clean(document.body ? document.body.innerText : "").slice(0, 2000),
    },
  };
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
page.setDefaultTimeout(45_000);

const records = [];
const attempts = [];
let pagesScanned = 0;
let usedUrl = "";
let stoppedOnAge = false;

try {
  for (const url of entryUrls) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
    } catch (error) {
      attempts.push({ url, error: String(error).slice(0, 200) });
      continue;
    }
    await page.waitForTimeout(4000);
    const probe = await page.evaluate(extractRows);
    attempts.push({ url, ...probe.diagnostic, rowsFound: probe.rows.length });
    if (probe.rows.length > 0) { usedUrl = url; records.push(...probe.rows); break; }
  }

  if (usedUrl) {
    pagesScanned = 1;
    const now = sgtNow();
    const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000);

    // The list is sorted newest first, so once a page is entirely older than
    // the window there is nothing further back worth walking.
    const pageIsOld = (rows) => rows.length > 0 && rows.every((row) => {
      const published = parseListingDate(row.published);
      return published && published < cutoff;
    });

    if (pageIsOld(records)) stoppedOnAge = true;

    for (let pageNumber = 2; pageNumber <= maxPages && !stoppedOnAge; pageNumber += 1) {
      const next = page.getByRole("button", { name: /^next$/i })
        .or(page.getByRole("link", { name: /^next$/i }))
        .first();
      if ((await next.count()) === 0) break;
      try {
        await next.click({ timeout: 15_000 });
        await page.waitForTimeout(3500);
      } catch {
        break;
      }
      const probe = await page.evaluate(extractRows);
      const seen = new Set(records.map((record) => record.reference));
      const fresh = probe.rows.filter((row) => !seen.has(row.reference));
      // The paginator not advancing looks identical to reaching the end.
      if (fresh.length === 0) break;
      records.push(...fresh);
      pagesScanned = pageNumber;
      if (pageIsOld(fresh)) { stoppedOnAge = true; break; }
    }
  }

  const unique = Array.from(new Map(records.map((record) => [record.reference, record])).values());

  if (unique.length === 0) {
    const dump = [
      `GeBIZ crawl found no opportunities — ${sgtStamp()}`,
      "",
      "The page structure assumption is wrong, not GeBIZ empty.",
      `Tried ${attempts.length} entry URL(s):`,
      JSON.stringify(attempts, null, 2),
    ].join("\n");
    await writeFile(diagnosticOutput, `${dump}\n`, "utf8");
    await writeFile(statusOutput, `${JSON.stringify({
      success: false, generated_at_sgt: sgtStamp(), records: 0,
      pages_scanned: pagesScanned,
      error: "no opportunity rows found — see GeBIZ_Raw_diagnostic.txt",
      source: usedUrl || entryUrls[0],
    }, null, 2)}\n`, "utf8");
    await writeFile(output, `${[
      "Tender/Ref No.", "Title", "Agency", "Procurement Category", "Source",
      "Scope Summary", "Publish Date/Time", "Closing Date/Time", "Status", "Link",
    ].map(csvCell).join(",")}\n`, "utf8");
    console.log(dump);
    throw new Error("GeBIZ rendered no opportunity rows — diagnostic written");
  }

  const header = [
    "Tender/Ref No.", "Title", "Agency", "Procurement Category", "Source",
    "Scope Summary", "Publish Date/Time", "Closing Date/Time", "Status", "Link",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const record of unique) {
    lines.push([
      record.fullReference || record.reference,
      record.title, record.agency, record.category, "GeBIZ",
      // The procurement type is worth keeping: it is the closest thing GeBIZ
      // gives to the route, which the pipeline sheet asks for.
      record.type ? `${record.type} (GeBIZ listing)` : "",
      record.published, record.closing,
      record.status === "OPEN" ? "Open" : record.status,
      record.link,
    ].map(csvCell).join(","));
  }
  await writeFile(output, `${lines.join("\n")}\n`, "utf8");

  await writeFile(diagnosticOutput, [
    `GeBIZ crawl OK — ${sgtStamp()}`,
    `Entry URL: ${usedUrl}`,
    `Rows: ${unique.length} across ${pagesScanned} page(s)`
      + `${stoppedOnAge ? ` (stopped at the ${maxAgeDays}-day window)` : ""}`,
    "",
    "First 5 rows as parsed — check the fields landed in the right columns:",
    ...unique.slice(0, 5).map((record, index) =>
      `\n[${index + 1}] ref=${record.fullReference}`
      + `\n    type=${record.type}  status=${record.status}`
      + `\n    title=${record.title}`
      + `\n    agency=${record.agency}`
      + `\n    category=${record.category}`
      + `\n    published=${record.published}`
      + `\n    closing=${record.closing}`),
  ].join("\n") + "\n", "utf8");

  const status = {
    success: true, generated_at_sgt: sgtStamp(), records: unique.length,
    pages_scanned: pagesScanned, max_age_days: maxAgeDays,
    stopped_on_age: stoppedOnAge, source: usedUrl,
  };
  await writeFile(statusOutput, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...status, output, statusOutput }));
} finally {
  await browser.close();
}
