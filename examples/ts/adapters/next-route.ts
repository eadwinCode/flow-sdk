// Next.js App Router: put this in app/api/flow/route.ts.
// Settings come from process.env.
// #region next
import { serve } from "@clevix/flow/next";
import { flow, hello } from "./functions.ts";

export const { GET, POST, PUT } = serve({ client: flow, functions: [hello] });
// #endregion next
