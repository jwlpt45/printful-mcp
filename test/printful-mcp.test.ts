import { readFileSync, readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PrintfulClient } from "../src/printful.js";
import { redactSecrets } from "../src/redact.js";
import { createServer } from "../src/server.js";

const TOKEN = "example-api-credential";
const BASE = "https://api.printful.com";

const requests: Array<{ method: string; url: string; headers: Headers; body: string }> = [];
const sleepCalls: number[] = [];

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  requests.length = 0;
  sleepCalls.length = 0;
});

afterAll(() => {
  server.close();
});

function client(options: { storeId?: string; maxRateLimitWaitMs?: number } = {}): PrintfulClient {
  return new PrintfulClient({
    token: TOKEN,
    baseUrl: BASE,
    jitterMs: () => 0,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    ...(options.storeId ? { storeId: options.storeId } : {}),
    ...(options.maxRateLimitWaitMs !== undefined ? { maxRateLimitWaitMs: options.maxRateLimitWaitMs } : {}),
  });
}

function capture(handler: Parameters<typeof http.get>[1]): Parameters<typeof http.get>[1] {
  return async (info) => {
    const body = info.request.method === "GET" || info.request.method === "HEAD" ? "" : await info.request.clone().text();
    requests.push({
      method: info.request.method,
      url: info.request.url,
      headers: info.request.headers,
      body,
    });
    return handler(info);
  };
}

function ok(result: unknown, headers?: Record<string, string>) {
  return HttpResponse.json(
    { code: 200, result },
    {
      status: 200,
      headers: {
        "X-RateLimit-Limit": "120",
        "X-RateLimit-Remaining": "119",
        "X-RateLimit-Reset": "40",
        ...headers,
      },
    },
  );
}

async function connect(printful: PrintfulClient): Promise<Client> {
  const mcpServer = createServer(printful, [TOKEN]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const mcp = new Client({ name: "printful-mcp-test", version: "0.0.0" });
  await mcp.connect(clientTransport);
  return mcp;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((block) => block.text ?? "").join("\n");
}

const sampleRecipient = {
  name: "Jane Doe",
  address1: "Address line 1",
  city: "Sample City",
  state_code: "CA",
  country_code: "US",
  zip: "00000",
};

describe("config and redaction", () => {
  it("rejects a missing token without echoing the environment", () => {
    expect(() => loadConfig({})).toThrow(/PRINTFUL_API_TOKEN is not set/);
  });

  it("treats a blank or unsubstituted token as missing", () => {
    expect(() => loadConfig({ PRINTFUL_API_TOKEN: "   " })).toThrow(/PRINTFUL_API_TOKEN is not set/);
    expect(() => loadConfig({ PRINTFUL_API_TOKEN: "${PRINTFUL_API_TOKEN}" })).toThrow(/PRINTFUL_API_TOKEN is not set/);
  });

  it("reads an optional store id and ignores a blank one", () => {
    expect(loadConfig({ PRINTFUL_API_TOKEN: TOKEN, PRINTFUL_STORE_ID: " example-store " }).storeId).toBe(
      "example-store",
    );
    expect(loadConfig({ PRINTFUL_API_TOKEN: TOKEN, PRINTFUL_STORE_ID: "" }).storeId).toBeUndefined();
  });

  it("redacts secret values", () => {
    expect(redactSecrets(`leaked ${TOKEN} end`, [TOKEN])).toBe("leaked [redacted] end");
  });
});

describe("Printful HTTP client", () => {
  it("sends the bearer token and store header without putting the token in the URL", async () => {
    server.use(
      http.get(
        `${BASE}/stores`,
        capture(() => ok([{ id: 1, type: "native", name: "Example Store" }])),
      ),
    );

    const result = await client({ storeId: "example-store" }).listStores();
    expect(result.result).toEqual([{ id: 1, type: "native", name: "Example Store" }]);
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.headers.get("x-pf-store-id")).toBe("example-store");
    expect(requests[0]?.url.includes(TOKEN)).toBe(false);
    expect(result.rateLimit).toEqual({ limit: 120, remaining: 119, resetSeconds: 40 });
  });

  it("omits the store header when no store id is configured", async () => {
    server.use(http.get(`${BASE}/stores`, capture(() => ok([]))));
    await client().listStores();
    expect(requests[0]?.headers.get("x-pf-store-id")).toBeNull();
  });

  it("retries a short 429 once, then returns the successful body", async () => {
    let calls = 0;
    server.use(
      http.get(
        `${BASE}/stores`,
        capture(() => {
          calls += 1;
          if (calls === 1) {
            return HttpResponse.json(
              {
                code: 429,
                result: "slow down",
                error: { reason: "TooManyRequests", message: `slow down ${TOKEN}` },
              },
              { status: 429, headers: { "Retry-After": "0" } },
            );
          }
          return ok([{ id: 1, name: "Example Store" }]);
        }),
      ),
    );

    const result = await client().listStores();
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([0]);
    expect(result.result).toEqual([{ id: 1, name: "Example Store" }]);
  });

  it("returns a helpful error for a long 429 and does not keep retrying", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/stores`, () => {
        calls += 1;
        return HttpResponse.json(
          { code: 429, result: "slow down", error: { reason: "TooManyRequests", message: "slow down" } },
          { status: 429, headers: { "Retry-After": "38" } },
        );
      }),
    );

    await expect(client({ maxRateLimitWaitMs: 5_000 }).listStores()).rejects.toThrow(
      /rate limit reached \(429\)[\s\S]*38 seconds/,
    );
    expect(calls).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it("strips the token from API error bodies", async () => {
    server.use(
      http.get(`${BASE}/stores`, () =>
        HttpResponse.json(
          { code: 401, result: "unauthorized", error: { reason: "Unauthorized", message: `bad ${TOKEN}` } },
          { status: 401 },
        ),
      ),
    );

    await expect(client().listStores()).rejects.toThrow(/\[redacted\]/);
    await expect(client().listStores()).rejects.not.toThrow(new RegExp(TOKEN));
  });

  it("forces draft creation and drops a confirm flag from the body", async () => {
    server.use(
      http.post(
        `${BASE}/orders`,
        capture(async () => ok({ id: 10, status: "draft" })),
      ),
    );

    await client().createDraftOrder({
      confirm: true,
      recipient: sampleRecipient,
      items: [{ variant_id: 4012, quantity: 1 }],
    });

    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/orders");
    expect(url.searchParams.get("confirm")).toBe("false");
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.confirm).toBeUndefined();
    expect(body.items).toEqual([{ variant_id: 4012, quantity: 1 }]);
  });
});

describe("MCP tools", () => {
  it("advertises the Printful tool set", async () => {
    server.use(http.get(`${BASE}/stores`, () => ok([])));
    const mcp = await connect(client());
    const listed = await mcp.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "cancel_order",
        "confirm_order",
        "create_mockup_task",
        "create_order",
        "create_sync_product",
        "estimate_order_costs",
        "get_mockup_task",
        "get_order",
        "get_product",
        "get_shipping_rates",
        "get_variants",
        "list_orders",
        "list_stores",
        "list_sync_products",
        "search_catalog",
        "upload_file",
      ].sort(),
    );
    const createOrder = listed.tools.find((tool) => tool.name === "create_order");
    expect(JSON.stringify(createOrder?.inputSchema)).not.toContain("confirm");
    const confirmOrder = listed.tools.find((tool) => tool.name === "confirm_order");
    expect(JSON.stringify(confirmOrder?.inputSchema)).toContain("confirm");
  });

  it("filters the catalog locally", async () => {
    server.use(
      http.get(
        `${BASE}/products`,
        capture(() =>
          ok([
            { id: 71, title: "Unisex Staple T-Shirt", brand: "Bella + Canvas", type: "T-SHIRT", model: "3001" },
            { id: 1, title: "Ceramic Mug", brand: "Example", type: "MUG", model: "11oz" },
          ]),
        ),
      ),
    );
    const mcp = await connect(client());
    const result = await mcp.callTool({
      name: "search_catalog",
      arguments: { query: "mug", limit: 10 },
    });
    const payload = JSON.parse(toolText(result)) as { result: Array<{ id: number }>; paging: { total: number } };
    expect(payload.result.map((item) => item.id)).toEqual([1]);
    expect(payload.paging.total).toBe(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/products");
  });

  it("creates a draft through the tool and never confirms it", async () => {
    server.use(http.post(`${BASE}/orders`, capture(async () => ok({ id: 44, status: "draft" }))));
    const mcp = await connect(client());
    const result = await mcp.callTool({
      name: "create_order",
      arguments: {
        recipient: sampleRecipient,
        items: [{ variant_id: 4012, quantity: 2, files: [{ url: "https://example.com/art.png", type: "front" }] }],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(toolText(result)).toContain("Draft order created");
    expect(new URL(requests[0]!.url).searchParams.get("confirm")).toBe("false");
    expect(toolText(result)).not.toContain(TOKEN);
  });

  it("refuses confirm_order unless confirm is true, then posts to the confirm endpoint", async () => {
    server.use(
      http.post(
        `${BASE}/orders/44/confirm`,
        capture(() => ok({ id: 44, status: "pending" })),
      ),
    );
    const mcp = await connect(client());
    const rejected = await mcp.callTool({ name: "confirm_order", arguments: { order_id: 44 } });
    expect(rejected.isError).toBe(true);
    expect(requests).toHaveLength(0);

    const accepted = await mcp.callTool({
      name: "confirm_order",
      arguments: { order_id: 44, confirm: true },
    });
    expect(accepted.isError).not.toBe(true);
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe("/orders/44/confirm");
    expect(toolText(accepted)).toContain("submitted for fulfillment");
  });

  it("covers shipping, estimates, orders, sync products, files, and mockups", async () => {
    server.use(
      http.post(`${BASE}/shipping/rates`, capture(() => ok([{ id: "STANDARD", rate: "4.00", currency: "USD" }]))),
      http.post(`${BASE}/orders/estimate-costs`, capture(() => ok({ costs: { total: 15 } }))),
      http.get(`${BASE}/orders`, capture(() => ok([{ id: 9, status: "draft" }]))),
      http.get(`${BASE}/orders/9`, capture(() => ok({ id: 9, status: "draft" }))),
      http.delete(`${BASE}/orders/9`, capture(() => ok({ id: 9, status: "canceled" }))),
      http.get(`${BASE}/products/71`, capture(() => ok({ product: { id: 71 }, variants: [{ id: 4012 }] }))),
      http.get(`${BASE}/products/variant/4012`, capture(() => ok({ variant: { id: 4012 } }))),
      http.get(`${BASE}/sync/products`, capture(() => ok([{ id: 3, name: "Example tee" }]))),
      http.post(`${BASE}/store/products`, capture(() => ok({ id: 3, name: "Example tee" }))),
      http.post(`${BASE}/files`, capture(() => ok({ id: 8, status: "waiting" }))),
      http.post(
        `${BASE}/mockup-generator/create-task/71`,
        capture(() => ok({ task_key: "task-1", status: "pending" })),
      ),
      http.get(
        `${BASE}/mockup-generator/task`,
        capture(() => ok({ task_key: "task-1", status: "completed", mockups: [] })),
      ),
    );

    const mcp = await connect(client());
    const shipping = await mcp.callTool({
      name: "get_shipping_rates",
      arguments: {
        recipient: { country_code: "US", state_code: "CA" },
        items: [{ variant_id: 4012, quantity: 1 }],
      },
    });
    expect(toolText(shipping)).toContain("STANDARD");

    const estimate = await mcp.callTool({
      name: "estimate_order_costs",
      arguments: { recipient: sampleRecipient, items: [{ variant_id: 4012, quantity: 1 }] },
    });
    expect(toolText(estimate)).toContain("No order was created");

    expect(toolText(await mcp.callTool({ name: "list_orders", arguments: { status: "draft", limit: 5 } }))).toContain(
      "draft",
    );
    expect(new URL(requests.find((request) => request.url.includes("/orders?"))!.url).searchParams.get("status")).toBe(
      "draft",
    );

    expect(toolText(await mcp.callTool({ name: "get_order", arguments: { order_id: 9 } }))).toContain("\"id\": 9");
    expect(toolText(await mcp.callTool({ name: "cancel_order", arguments: { order_id: 9 } }))).toContain("canceled");
    expect(requests.some((request) => request.method === "DELETE" && request.url.endsWith("/orders/9"))).toBe(true);

    const variants = JSON.parse(
      toolText(await mcp.callTool({ name: "get_variants", arguments: { product_id: 71 } })),
    ) as { result: Array<{ id: number }> };
    expect(variants.result).toEqual([{ id: 4012 }]);

    const oneVariant = await mcp.callTool({ name: "get_variants", arguments: { variant_id: 4012 } });
    expect(toolText(oneVariant)).toContain("4012");

    const missing = await mcp.callTool({ name: "get_variants", arguments: {} });
    expect(missing.isError).toBe(true);

    const sync = await mcp.callTool({
      name: "create_sync_product",
      arguments: {
        name: "Example tee",
        variant_ids: [4012, 4013],
        file_url: "https://example.com/art.png",
        placement: "front",
        retail_price: "28.00",
      },
    });
    expect(sync.isError).not.toBe(true);
    const syncRequest = requests.find((request) => request.url.endsWith("/store/products"));
    const syncBody = JSON.parse(syncRequest!.body) as {
      sync_variants: Array<{ variant_id: number; files: Array<{ type: string; url: string }> }>;
    };
    expect(syncBody.sync_variants).toHaveLength(2);
    expect(syncBody.sync_variants[0]?.files).toEqual([{ type: "front", url: "https://example.com/art.png" }]);

    const uploaded = await mcp.callTool({
      name: "upload_file",
      arguments: { url: "https://example.com/art.png", filename: "art.png" },
    });
    expect(toolText(uploaded)).toContain("waiting");

    const task = await mcp.callTool({
      name: "create_mockup_task",
      arguments: {
        product_id: 71,
        variant_ids: [4012],
        file_url: "https://example.com/art.png",
        placement: "front",
      },
    });
    expect(toolText(task)).toContain("task-1");
    const taskBody = JSON.parse(
      requests.find((request) => request.url.includes("/mockup-generator/create-task/71"))!.body,
    ) as { files: Array<{ placement: string; image_url: string }> };
    expect(taskBody.files).toEqual([{ placement: "front", image_url: "https://example.com/art.png" }]);

    const fetched = await mcp.callTool({ name: "get_mockup_task", arguments: { task_key: "task-1" } });
    expect(toolText(fetched)).toContain("completed");
    expect(requests.some((request) => request.url.includes("task_key=task-1"))).toBe(true);
  });

  it("surfaces API failures as tool errors without the token", async () => {
    server.use(
      http.get(`${BASE}/products/71`, () =>
        HttpResponse.json(
          { code: 404, result: "missing", error: { reason: "NotFound", message: `no product ${TOKEN}` } },
          { status: 404 },
        ),
      ),
    );
    const mcp = await connect(client());
    const result = await mcp.callTool({ name: "get_product", arguments: { product_id: 71 } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("NotFound");
    expect(toolText(result)).not.toContain(TOKEN);
    expect(toolText(result)).toContain("[redacted]");
  });
});

describe("plugin manifests", () => {
  const requiredInterface = [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "capabilities",
    "websiteURL",
    "defaultPrompt",
    "brandColor",
    "composerIcon",
    "logo",
  ];

  it("parses marketplace manifests and points the server at npx printful-mcp", () => {
    for (const path of [
      ".cursor-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
    ]) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        name: string;
        author: { name: string; email?: string; url: string };
        license: string;
        logo: string;
        skills: string;
        mcpServers: { printful: { command: string; args: string[]; env: Record<string, string> } };
        interface: Record<string, unknown>;
      };
      expect(manifest.name).toBe("printful-mcp");
      expect(manifest.author.name).toBe("Bootheel Faith Co.");
      expect(manifest.author.email).toBeUndefined();
      expect(manifest.license).toBe("MIT");
      expect(manifest.logo).toBe("./assets/logo.png");
      expect(manifest.skills).toBe("./skills/");
      expect(manifest.mcpServers.printful).toEqual({
        command: "npx",
        args: ["-y", "printful-mcp"],
        env: { PRINTFUL_API_TOKEN: "${PRINTFUL_API_TOKEN}" },
      });
      expect(manifest.interface.developerName).toBe("Bootheel Faith Co.");
      for (const key of requiredInterface) {
        expect(manifest.interface[key], `${path} interface.${key}`).toBeTruthy();
      }
    }

    const mcp = JSON.parse(readFileSync(".mcp.json", "utf8")) as {
      mcpServers: { printful: { command: string; args: string[] } };
    };
    expect(mcp.mcpServers.printful.command).toBe("npx");
    expect(mcp.mcpServers.printful.args).toEqual(["-y", "printful-mcp"]);

    const skills = readdirSync("skills", { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(skills.length).toBeGreaterThanOrEqual(2);
  });
});
