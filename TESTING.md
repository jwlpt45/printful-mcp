# Testing printful-mcp

Automated tests mock Printful with MSW. They do not use a token and they do not call the network.

## Automated tests and build

```bash
npm install
npm test
npm run build
```

`npm test` covers the private-token header, redaction, 429 handling, draft-only order creation, and the tool list. `npm run build` compiles the stdio server to `dist/`.

## Run against Printful

Create a private token in the Printful Developer Portal, then export it in the shell that starts the server. Do not commit the token.

```bash
export PRINTFUL_API_TOKEN="your-private-token"
# Optional. Use this for an account-level token after list_stores shows the store you want.
export PRINTFUL_STORE_ID="your-store-id"
npm start
```

`npm start` expects `npm run build` to have been run. `npx -y printful-mcp` is the same server once the package is installed from the registry.

## Example read-only calls

With the token exported and `dist/` built, this starts the server over stdio and calls two read-only tools. `list_stores` lists stores visible to the token. `search_catalog` loads the catalog and filters it locally.

```bash
node --input-type=module <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: process.env,
});
const client = new Client({ name: "printful-mcp-manual", version: "0.0.0" });
await client.connect(transport);
console.log(JSON.stringify(await client.callTool({ name: "list_stores", arguments: {} }), null, 2));
console.log(JSON.stringify(await client.callTool({
  name: "search_catalog",
  arguments: { query: "t-shirt", limit: 5 },
}), null, 2));
await client.close();
EOF
```

`get_product` and `get_variants` are also read-only. Pass a catalog product id from the search results.

## Orders stay drafts

`create_order` always sends `confirm=false` and removes any confirm flag from the body. It saves a draft and does not charge the store. Fulfillment happens only if you later call `confirm_order` with `confirm` set to `true`. Use `estimate_order_costs` when you want prices without creating a draft. Prefer a unique `external_id` on `create_order` so a retry cannot create a second draft.
