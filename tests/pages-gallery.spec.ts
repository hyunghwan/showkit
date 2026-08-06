import { expect, test } from "@playwright/test";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagesRoot = path.join(repositoryRoot, "output", "pages");
const mediaTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".png", "image/png"]
]);

let server: Server;
let pageUrl: string;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent((request.url ?? "/").split("?", 1)[0] ?? "/");
      const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      const filePath = path.resolve(pagesRoot, relativePath);
      if (!filePath.startsWith(`${pagesRoot}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "Content-Type": mediaTypes.get(path.extname(filePath)) ?? "application/octet-stream",
        "Content-Length": fileStat.size,
        "Cache-Control": "no-store"
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  pageUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("selects the three current landing-page demos", async ({ page }) => {
  const requestedDemos: string[] = [];
  await page.route("https://showkit.sqncs.com/demos/**", async (route) => {
    requestedDemos.push(route.request().url());
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>ShowKit demo fixture</title><p>Demo ready</p>"
    });
  });

  await page.goto(pageUrl);

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await expect(tabs).toHaveText([/Airbnb demo/, /Linear demo/, /Stripe demo/]);

  const frame = page.locator("#showkit-demo");
  await expect(frame).toHaveAttribute(
    "src",
    "https://showkit.sqncs.com/demos/travel-search/?release=2026-08-05-linear-agent-project"
  );
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(
    "Explore flexible travel dates"
  );

  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(frame).toHaveAttribute("src", /\/demos\/issue-priority\//);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(
    "Scaffold a project with Linear Agent"
  );

  await tabs.nth(1).press("ArrowRight");
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(frame).toHaveAttribute("src", /\/demos\/stripe-payments\//);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(
    "Filter payments by date and amount"
  );
  await expect(page.locator("#open-demo")).toHaveAttribute(
    "href",
    /\/demos\/stripe-payments\//
  );
  await expect.poll(() => requestedDemos.length).toBeGreaterThanOrEqual(3);
});

test("keeps the selector usable on a narrow viewport", async ({ page }) => {
  await page.route("https://showkit.sqncs.com/demos/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Demo</title>" })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${pageUrl}/?demo=stripe-payments`);

  await expect(page.getByRole("tab", { name: /Stripe demo/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.locator("#showkit-demo")).toHaveAttribute(
    "title",
    "Filter payments by date and amount interactive demo"
  );
  await expect(page.locator(".demo-stage")).toBeInViewport();
});
