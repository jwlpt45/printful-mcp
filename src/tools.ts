import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PrintfulApiError, type PrintfulClient, type PrintfulResult } from "./printful.js";
import { redactSecrets } from "./redact.js";

const recipientSchema = z.object({
  name: z.string().min(1).describe("Recipient name."),
  address1: z.string().min(1).describe("First line of the delivery location."),
  address2: z.string().optional(),
  city: z.string().min(1),
  state_code: z.string().optional().describe("Required by Printful for US, CA, and AU shipments."),
  country_code: z.string().length(2).describe("ISO 3166-1 alpha-2 country code."),
  zip: z.string().min(1),
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});

const shippingRecipientSchema = z.object({
  country_code: z.string().length(2).describe("Required. ISO country code."),
  state_code: z.string().optional().describe("Required for US, CA, and AU."),
  city: z.string().optional(),
  zip: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  phone: z.string().optional(),
});

const orderFileSchema = z.object({
  url: z.string().url().describe("Public URL Printful can download."),
  type: z.string().min(1).default("default").describe("Placement such as default, front, or back."),
  filename: z.string().optional(),
});

const orderItemSchema = z.object({
  variant_id: z.number().int().positive().optional().describe("Catalog variant id."),
  sync_variant_id: z.number().int().positive().optional().describe("Existing sync variant id."),
  quantity: z.number().int().positive(),
  retail_price: z.string().optional(),
  name: z.string().optional(),
  files: z.array(orderFileSchema).optional(),
});

const orderDraftSchema = {
  external_id: z.string().min(1).optional().describe("Your own id. Use one so a retry cannot duplicate the order."),
  shipping: z.string().min(1).optional().describe("Shipping method id from get_shipping_rates. Defaults to STANDARD at Printful."),
  recipient: recipientSchema,
  items: z.array(orderItemSchema).min(1),
};

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: unknown, secrets: readonly string[]) {
  const message = error instanceof Error ? error.message : "Unexpected Printful error.";
  const retry =
    error instanceof PrintfulApiError && error.retryAfterSeconds !== undefined
      ? ` Retry after ${error.retryAfterSeconds} seconds.`
      : "";
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: redactSecrets(`${message}${retry}`, secrets),
      },
    ],
  };
}

function present(summary: string, response: PrintfulResult<unknown>) {
  return textResult({
    summary,
    ...(Object.keys(response.rateLimit).length > 0 ? { rate_limit: response.rateLimit } : {}),
    ...(response.paging ? { paging: response.paging } : {}),
    result: response.result,
  });
}

function requireItemSource(items: Array<{ variant_id?: number; sync_variant_id?: number }>): string | undefined {
  for (const [index, item] of items.entries()) {
    if (item.variant_id === undefined && item.sync_variant_id === undefined) {
      return `Item ${index + 1} needs a variant_id or a sync_variant_id.`;
    }
  }
  return undefined;
}

interface CatalogProduct {
  id?: number;
  title?: string;
  brand?: string;
  model?: string;
  type?: string;
  type_name?: string;
  description?: string;
}

function catalogHaystack(product: CatalogProduct): string {
  return [product.title, product.brand, product.model, product.type, product.type_name, product.description]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
}

export function registerTools(server: McpServer, client: PrintfulClient, secrets: readonly string[] = []): void {
  const guard = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      return errorResult(error, secrets);
    }
  };

  server.registerTool(
    "list_stores",
    {
      title: "List stores",
      description:
        "List Printful stores visible to the private token. Use a store id from this list as PRINTFUL_STORE_ID when the token is account-level.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guard(async () => present("Stores visible to this token.", await client.listStores())),
  );

  server.registerTool(
    "search_catalog",
    {
      title: "Search catalog",
      description:
        "Search the Printful product catalog. The v1 catalog endpoint has no text query, so this loads the catalog (optionally by category_id) and filters title, brand, model, and type locally. Results are paged with offset and limit (default 20, max 100).",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive match against product title, brand, model, or type."),
        category_id: z.string().optional().describe("Printful category id or comma-separated category ids."),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, category_id, offset, limit }) =>
      guard(async () => {
        const response = await client.listCatalogProducts(category_id);
        const products = Array.isArray(response.result) ? (response.result as CatalogProduct[]) : [];
        const needle = query?.trim().toLowerCase();
        const filtered = needle ? products.filter((product) => catalogHaystack(product).includes(needle)) : products;
        const start = offset ?? 0;
        const pageSize = limit ?? 20;
        const page = filtered.slice(start, start + pageSize);
        return textResult({
          summary: needle
            ? `Catalog matches for "${query}".`
            : "Printful catalog page. Pass query to filter by title, brand, model, or type.",
          paging: { total: filtered.length, offset: start, limit: pageSize },
          ...(Object.keys(response.rateLimit).length > 0 ? { rate_limit: response.rateLimit } : {}),
          result: page,
        });
      }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get catalog product",
      description: "Get one Printful catalog product, including its variants, by catalog product id.",
      inputSchema: {
        product_id: z.number().int().positive(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ product_id }) =>
      guard(async () => present(`Catalog product ${product_id}.`, await client.getProduct(product_id))),
  );

  server.registerTool(
    "get_variants",
    {
      title: "Get catalog variants",
      description:
        "Get variants for a catalog product, or one variant by variant id. Pass product_id or variant_id, not both.",
      inputSchema: {
        product_id: z.number().int().positive().optional(),
        variant_id: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ product_id, variant_id }) =>
      guard(async () => {
        if ((product_id === undefined) === (variant_id === undefined)) {
          return errorResult(
            new Error("Pass exactly one of product_id (all variants for that product) or variant_id (one variant)."),
            secrets,
          );
        }
        if (variant_id !== undefined) {
          return present(`Catalog variant ${variant_id}.`, await client.getVariant(variant_id));
        }
        const response = await client.getProduct(product_id as number);
        const record = response.result as { variants?: unknown };
        const variants = record && typeof record === "object" && "variants" in record ? record.variants : response.result;
        return present(`Variants for catalog product ${product_id}.`, { ...response, result: variants });
      }),
  );

  server.registerTool(
    "get_shipping_rates",
    {
      title: "Get shipping rates",
      description:
        "Calculate Printful shipping options for catalog or warehouse items. country_code is required. state_code is required for US, CA, and AU. These rates can differ from estimate_order_costs when store shipping settings apply.",
      inputSchema: {
        recipient: shippingRecipientSchema,
        items: z
          .array(
            z.object({
              variant_id: z.union([z.string(), z.number()]).optional(),
              external_variant_id: z.string().optional(),
              warehouse_product_variant_id: z.union([z.string(), z.number()]).optional(),
              quantity: z.number().int().positive(),
              value: z.string().optional().describe("Declared customs value, when needed."),
            }),
          )
          .min(1),
        currency: z.string().length(3).optional(),
        locale: z.enum(["en_US", "es_ES"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => present("Shipping rates for this destination and item list.", await client.getShippingRates(args))),
  );

  server.registerTool(
    "estimate_order_costs",
    {
      title: "Estimate order costs",
      description:
        "Estimate item, print, shipping, and tax costs without creating an order. Call this before create_order. Nothing is charged.",
      inputSchema: orderDraftSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const itemError = requireItemSource(args.items);
        if (itemError) return errorResult(new Error(itemError), secrets);
        return present("Estimated costs. No order was created and nothing was charged.", await client.estimateOrderCosts(args));
      }),
  );

  server.registerTool(
    "create_order",
    {
      title: "Create draft order",
      description:
        "Create a Printful order as a DRAFT only. This tool always sends confirm=false, ignores any confirm flag, and never charges the store. Fulfillment happens only if you later call confirm_order with confirm set to true. Prefer a unique external_id so a retry cannot duplicate the draft.",
      inputSchema: orderDraftSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const itemError = requireItemSource(args.items);
        if (itemError) return errorResult(new Error(itemError), secrets);
        const response = await client.createDraftOrder(args);
        const status =
          response.result && typeof response.result === "object" && "status" in response.result
            ? String((response.result as { status?: unknown }).status)
            : undefined;
        const warning =
          status && status !== "draft"
            ? ` Unexpected status "${status}". Do not fulfill this order until you have checked it in Printful.`
            : "";
        return present(
          `Draft order created. It is not submitted for fulfillment and the store has not been charged.${warning} Call confirm_order only after the shopper explicitly agrees.`,
          response,
        );
      }),
  );

  server.registerTool(
    "confirm_order",
    {
      title: "Confirm draft order",
      description:
        "Submit an existing DRAFT order for fulfillment. This charges the store payment method. confirm must be the boolean true. Do not call this unless a person explicitly asked to place and pay for the order.",
      inputSchema: {
        order_id: z.union([z.string().min(1), z.number().int()]).describe("Printful order id."),
        confirm: z
          .literal(true)
          .describe("Must be true. Confirming charges the store payment method and submits the draft for fulfillment."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ order_id }) =>
      guard(async () =>
        present(
          `Order ${order_id} was submitted for fulfillment. The store payment method may be charged.`,
          await client.confirmOrder(order_id),
        ),
      ),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description: "Cancel a draft or pending Printful order. Charged amounts are returned by Printful when the order is eligible.",
      inputSchema: {
        order_id: z.union([z.string().min(1), z.number().int()]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ order_id }) =>
      guard(async () => present(`Cancellation requested for order ${order_id}.`, await client.cancelOrder(order_id))),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one Printful order by id, including status, costs, and shipments.",
      inputSchema: {
        order_id: z.union([z.string().min(1), z.number().int()]),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ order_id }) => guard(async () => present(`Order ${order_id}.`, await client.getOrder(order_id))),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "List orders for the current store. Filter by status (for example draft, pending, fulfilled, canceled). limit max is 100.",
      inputSchema: {
        status: z.string().optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => present("Orders for the current store.", await client.listOrders(args))),
  );

  server.registerTool(
    "list_sync_products",
    {
      title: "List sync products",
      description:
        "List sync products in the connected store. status can be all, synced, unsynced, ignored, imported, discontinued, or out_of_stock.",
      inputSchema: {
        search: z.string().optional(),
        status: z
          .enum(["all", "synced", "unsynced", "ignored", "imported", "discontinued", "out_of_stock"])
          .optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => present("Sync products for the current store.", await client.listSyncProducts(args))),
  );

  server.registerTool(
    "create_sync_product",
    {
      title: "Create sync product",
      description:
        "Create a sync product from one or more catalog variant ids, a print-file URL, and a placement (front, back, default, or another Printful file type). The same file URL is applied to every variant.",
      inputSchema: {
        name: z.string().min(1),
        variant_ids: z.array(z.number().int().positive()).min(1).describe("Catalog variant ids."),
        file_url: z.string().url().describe("Public print-file URL."),
        placement: z.string().min(1).default("default").describe("Print placement, such as front, back, or default."),
        retail_price: z.string().optional().describe("Retail price applied to each variant, as a decimal string."),
        thumbnail_url: z.string().url().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ name, variant_ids, file_url, placement, retail_price, thumbnail_url }) =>
      guard(async () => {
        const response = await client.createSyncProduct({
          sync_product: {
            name,
            ...(thumbnail_url ? { thumbnail: thumbnail_url } : {}),
          },
          sync_variants: variant_ids.map((variant_id) => ({
            variant_id,
            ...(retail_price ? { retail_price } : {}),
            files: [{ type: placement, url: file_url }],
          })),
        });
        return present(`Sync product "${name}" was created with ${variant_ids.length} variant(s).`, response);
      }),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload file by URL",
      description:
        "Add a file to the Printful file library by URL. If the same URL already exists, Printful returns the existing file. Processing is asynchronous; status starts as waiting and later becomes ok or failed. Deprecated .ai, .psd, and .tiff sources are rejected by Printful.",
      inputSchema: {
        url: z.string().url(),
        type: z.string().min(1).optional().describe("Role of the file, such as default, front, or back."),
        filename: z.string().min(1).optional(),
        visible: z.boolean().optional().describe("Show the file in the Printful library. Defaults to true at Printful."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ url, type, filename, visible }) =>
      guard(async () =>
        present(
          "File library entry. If status is waiting, the file can still be referenced by id on a draft.",
          await client.uploadFile({
            url,
            ...(type ? { type } : {}),
            ...(filename ? { filename } : {}),
            ...(visible !== undefined ? { visible } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "create_mockup_task",
    {
      title: "Create mockup task",
      description:
        "Start an asynchronous Printful mockup task for a catalog product. This endpoint is tightly rate limited (about 2 to 10 calls per minute). Poll get_mockup_task with the returned task_key. On 429, wait the reported seconds before retrying.",
      inputSchema: {
        product_id: z.number().int().positive(),
        variant_ids: z.array(z.number().int().positive()).min(1),
        file_url: z.string().url(),
        placement: z.string().min(1).default("front"),
        format: z.enum(["jpg", "png"]).optional(),
        width: z.number().int().min(50).max(2000).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ product_id, variant_ids, file_url, placement, format, width }) =>
      guard(async () =>
        present(
          "Mockup task created. Call get_mockup_task with task_key until status is completed.",
          await client.createMockupTask(product_id, {
            variant_ids,
            files: [{ placement, image_url: file_url }],
            ...(format ? { format } : {}),
            ...(width !== undefined ? { width } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_mockup_task",
    {
      title: "Get mockup task",
      description: "Read a mockup generation task. When status is completed, result.mockups contains image URLs. If status is pending, wait and call again.",
      inputSchema: {
        task_key: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ task_key }) =>
      guard(async () => present(`Mockup task ${task_key}.`, await client.getMockupTask(task_key))),
  );
}
