import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const url = "https://www.tenderboard.biz/singaporetenders";
const output = "TenderBoard_Raw_latest.csv";
const statusOutput = "TenderBoard_Raw_status.json";
const maxPages = 10;
const maxAgeDays = 14;

const csvCell = (value = "") => `"${String(value).replaceAll('"', '""')}"`;

const monthIndex = new Map(
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    .map((month, index) => [month.toLowerCase(), index])
);

const sgtNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
const inferListingDate = (raw, now) => {
  const match = String(raw).trim().match(/^(\d{1,2})\s+([A-Za-z]{3})$/);
  if (!match) return null;
  const month = monthIndex.get(match[2].toLowerCase());
  if (month === undefined) return null;
  let year = now.getFullYear();
  let candidate = new Date(year, month, Number(match[1]));
  if (candidate.getTime() > now.getTime() + 2 * 86_400_000) {
    candidate = new Date(year - 1, month, Number(match[1]));
  }
  return candidate;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
page.setDefaultTimeout(30_000);

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Showing\\s+1\\s*-\\s*50\\s+of\\s+\\d+\\s+tenders/i").waitFor({ timeout: 30_000 });

  const records = [];
  const now = sgtNow();
  const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000);
  let pagesScanned = 0;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    await page.locator('a[class*="OpenDeals-viewLink"]').first().waitFor();

    const pageRecords = await page.locator('a[class*="OpenDeals-viewLink"]').evaluateAll((anchors) =>
      anchors.map((anchor) => {
        const row = anchor.closest(".mdl-grid.content-text");
        const cells = row ? Array.from(row.children) : [];
        const main = cells[0];
        const industryNode = main
          ? Array.from(main.querySelectorAll("div")).find((node) =>
              (node.textContent || "").trim().startsWith("Industry:")
            )
          : null;
        const mainChildren = main ? Array.from(main.children) : [];
        const agencyNode = mainChildren.length > 1 ? mainChildren[mainChildren.length - 1] : null;
        const dates = cells.length > 1
          ? (cells[1].innerText || "").split("-").map((part) => part.trim())
          : [];

        return {
          title: (anchor.textContent || "").trim(),
          category: (industryNode?.textContent || "").replace(/^Industry:\s*/i, "").trim(),
          agency: (agencyNode?.textContent || "").trim(),
          published: dates[0] || "",
          closes: dates.slice(1).join("-").trim(),
          link: anchor.href || "",
        };
      })
    );

    pagesScanned = pageNumber;
    let encounteredOldRecord = false;
    for (const record of pageRecords) {
      const publishedDate = inferListingDate(record.published, now);
      if (publishedDate && publishedDate < cutoff) {
        encounteredOldRecord = true;
        continue;
      }
      records.push(record);
    }

    if (encounteredOldRecord) break;

    const nextPage = page.locator("a", { hasText: new RegExp(`^${pageNumber + 1}$`) }).first();
    if (pageNumber === maxPages || (await nextPage.count()) === 0) break;
    await nextPage.click();
    await page.locator(`text=/Showing\\s+${pageNumber * 50 + 1}\\s*-/i`).waitFor();
  }

  if (records.length === 0) throw new Error("TenderBoard rendered no tender rows");

  const header = [
    "Tender/Ref No.", "Title", "Agency", "Procurement Category", "Source",
    "Scope Summary", "Publish Date/Time", "Closing Date/Time", "Status", "Link"
  ];
  const uniqueRecords = Array.from(new Map(records.map((record) => [
    [record.title, record.agency, record.published, record.closes].join("|"),
    record,
  ])).values());

  const lines = [header.map(csvCell).join(",")];
  for (const record of uniqueRecords) {
    lines.push([
      "", record.title, record.agency, record.category, "TenderBoard", "",
      record.published, record.closes, "Live", record.link || ""
    ].map(csvCell).join(","));
  }

  await writeFile(output, `${lines.join("\n")}\n`, "utf8");
  const generatedAt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Singapore",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date()).replace(" ", "T") + "+08:00";
  const status = {
    success: true,
    generated_at_sgt: generatedAt,
    records: uniqueRecords.length,
    pages_scanned: pagesScanned,
    max_age_days: maxAgeDays,
    source: url,
  };
  await writeFile(statusOutput, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...status, output, statusOutput }));
} finally {
  await browser.close();
}
