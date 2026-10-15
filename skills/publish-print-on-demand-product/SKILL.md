---
name: publish-print-on-demand-product
description: Publish a print-on-demand product on Printful from a catalog variant, a print file URL, and a placement. Use when asked to add a product, sync a design, or generate a mockup.
---

# Publish a print-on-demand product

Use the Printful MCP tools. Do not invent product or variant ids.

1. Call `search_catalog` with a short query (for example "t-shirt").
2. Call `get_product` on the chosen catalog product id, then `get_variants` if you need a size or color.
3. Optional: call `upload_file` with the public print-file URL. You can also pass that URL straight into the next steps. Do not use .ai, .psd, or .tiff files.
4. Optional: call `create_mockup_task` with the catalog product id, variant ids, file URL, and placement (`front`, `back`, or `default`). Then call `get_mockup_task` with the `task_key` until status is `completed`. If the tool reports a 429, wait the stated number of seconds before retrying. Mockup creation is limited to a few calls per minute.
5. Call `create_sync_product` with the product name, catalog `variant_ids`, `file_url`, and `placement`. Set `retail_price` only when the shopper has chosen one.

Tell the shopper the sync product id and, when a mockup finished, the image URLs. This flow does not place an order.
