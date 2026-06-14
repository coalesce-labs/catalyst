import type { SummarizeArgs, SummarizeProvider, SummarizeResult } from "./index";
import { type RunClaudeCli, runClaudeCli } from "../../claude-cli";

export const claudeCliProvider: SummarizeProvider = {
  name: "claude-cli",
  async summarize(
    args: SummarizeArgs & { runClaudeCli?: RunClaudeCli },
  ): Promise<SummarizeResult> {
    const run = args.runClaudeCli ?? runClaudeCli;
    const { text, tokens } = await run({
      model: args.model,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
    });
    if (text === null) {
      throw new Error("claude-cli provider produced no output");
    }
    return { summary: text, cost: 0, tokens };
  },
};
