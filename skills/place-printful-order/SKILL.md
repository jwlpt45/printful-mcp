---
name: place-printful-order
description: Safely place a Printful order by estimating cost, saving a draft, and confirming only after an explicit yes. Use when asked to ship, buy, or check out a print-on-demand item.
---

# Safely place a Printful order

Orders must follow this sequence. `create_order` cannot confirm or charge.

1. Resolve the catalog variant with `search_catalog`, `get_product`, and `get_variants`.
2. Call `get_shipping_rates` with the destination country code (and state code for US, CA, or AU) and the items.
3. Call `estimate_order_costs` with the same recipient, items, print-file URLs, and the chosen shipping method. Show the costs. Nothing has been ordered yet.
4. Call `create_order` with a unique `external_id` when you have one. This always saves a draft (`confirm=false`). Show the order id, status, and costs.
5. Stop. Ask the shopper to explicitly agree to pay and fulfill.
6. Only after that yes, call `confirm_order` with the order id and `confirm` set to true. Say that the store payment method may be charged.
7. If they say no, call `cancel_order` or leave the draft in place.

If any tool returns a rate-limit error, wait the reported seconds and retry once. Do not loop immediately.

Check status later with `get_order` or `list_orders`.
