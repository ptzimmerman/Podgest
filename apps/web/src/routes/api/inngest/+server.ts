import { serve } from "inngest/sveltekit";
import { inngest, functions } from "@podgest/workflows";

const handler = serve({
  client: inngest,
  functions,
});

export const GET = handler.GET;
export const POST = handler.POST;
export const PUT = handler.PUT;
