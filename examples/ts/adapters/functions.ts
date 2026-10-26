// One function, shared by the adapter examples in this folder.
import { Flow } from "@clevix/flow";

export const flow = new Flow({ id: "adapters" });

export const hello = flow.createFunction(
  { id: "hello" },
  { event: "demo/hello" },
  async ({ event, step }) => {
    return step.run("greet", () => `Hello, ${event.data.name}!`);
  },
);
