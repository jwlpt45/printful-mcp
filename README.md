# printful-mcp

Open-source [Model Context Protocol](https://modelcontextprotocol.io) server for the [official Printful REST API](https://developers.printful.com/docs/). It is generic: no store is hard-coded, and the private token stays in the environment.

`create_order` **always creates a draft**. It sends `confirm=false` and drops any confirm flag. Printful charges the store payment method and starts fulfillment only when you call `confirm_order` with `confirm` set to `true`.

Author: Bootheel Faith Co. License: MIT.

Repository and homepage: https://github.com/jwlpt45/printful-mcp

Logo: https://raw.githubusercontent.com/jwlpt45/printful-mcp/main/assets/logo.png

## Setup

Requires Node.js 20 or newer.

1. In the [Printful Developer Portal](https://developers.printful.com/), create a **private token**. A store-level token is enough for one store. An account-level token can see every store; set `PRINTFUL_STORE_ID` to the store you want (list them with `list_stores`).
2. Export the token in the environment that launches the server. Do not commit it, and do not paste it into chat logs.

```bash
export PRINTFUL_API_TOKEN="your-private-token"
# Optional. Required for account-level tokens on store-specific calls.
export PRINTFUL_STORE_ID="your-store-id"
```

3. Run the server over stdio:

```bash
npx -y printful-mcp
```

From a checkout:

```bash
npm install
npm run build
npm start
```

### MCP client config

```json
{
  "mcpServers": {
    "printful": {
      "command": "npx",
      "args": ["-y", "printful-mcp"],
      "env": {
        "PRINTFUL_API_TOKEN": "your-private-token"
      }
    }
  }
}
```

Add `"PRINTFUL_STORE_ID": "your-store-id"` inside `env` when the token is account-level. The same block is in `.mcp.json` and in `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `.claude-plugin/plugin.json`.

The server never writes the token to logs. Errors that echo it are redacted.

## Draft orders

| Tool | What it does |
| --- | --- |
| `estimate_order_costs` | Prices a shipment. Creates nothing. |
| `create_order` | Saves a **draft**. Never confirms. |
| `confirm_order` | Submits that draft for fulfillment. Requires `confirm: true`. This can charge the store. |
| `cancel_order` | Cancels a draft or pending order when Printful allows it. |

Give `create_order` your own `external_id` so a retry after a timeout cannot create a second draft.

Printful allows about 120 requests per minute on the general API, and much less for mockup generation and sync-product writes. A `429` includes how many seconds to wait. This server retries once when that wait is 5 seconds or less. Longer lockouts are returned as an error so the caller can wait and try again.

## Tools

| Tool | API |
| --- | --- |
| `list_stores` | `GET /stores` |
| `search_catalog` | `GET /products`, then a local text filter (the v1 catalog list has no search parameter) |
| `get_product` | `GET /products/{id}` |
| `get_variants` | Product variants, or `GET /products/variant/{id}` |
| `get_shipping_rates` | `POST /shipping/rates` |
| `estimate_order_costs` | `POST /orders/estimate-costs` |
| `create_order` | `POST /orders?confirm=false` |
| `confirm_order` | `POST /orders/{id}/confirm` |
| `cancel_order` | `DELETE /orders/{id}` |
| `get_order` | `GET /orders/{id}` |
| `list_orders` | `GET /orders` |
| `list_sync_products` | `GET /sync/products` |
| `create_sync_product` | `POST /store/products` from catalog variant ids, a print-file URL, and a placement |
| `upload_file` | `POST /files` by URL |
| `create_mockup_task` | `POST /mockup-generator/create-task/{product_id}` |
| `get_mockup_task` | `GET /mockup-generator/task?task_key=` |

### Example draft

Recipient fields below are fictional.

```json
{
  "shipping": "STANDARD",
  "recipient": {
    "name": "Jane Doe",
    "address1": "Address line 1",
    "city": "Sample City",
    "state_code": "CA",
    "country_code": "US",
    "zip": "00000"
  },
  "items": [
    {
      "variant_id": 4012,
      "quantity": 1,
      "files": [{ "type": "front", "url": "https://example.com/art.png" }]
    }
  ]
}
```

Pass that object to `estimate_order_costs`, then to `create_order`. Stop there until someone explicitly agrees to pay. Then call `confirm_order` with `{ "order_id": 44, "confirm": true }`.

## Skills

- `skills/publish-print-on-demand-product/` — catalog variant, print file, mockup, sync product.
- `skills/place-printful-order/` — estimate, draft, then confirm only after an explicit yes.

## Development

Tests mock HTTP with [MSW](https://mswjs.io/). They do not call Printful.

```bash
npm test
npm run build
```

## License

MIT, Copyright 2026 Bootheel Faith Co. See [LICENSE](LICENSE).
