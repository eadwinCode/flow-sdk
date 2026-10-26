// Cloudflare Workers: the whole Worker is the endpoint.
// Settings come from the Worker's env (wrangler secrets and vars).
// #region worker
import { serve } from "@clevix/flow/cloudflare";
import { flow, hello } from "./functions.ts";

export default serve({ client: flow, functions: [hello] });
// #endregion worker
